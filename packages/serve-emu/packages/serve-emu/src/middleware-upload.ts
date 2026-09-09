import {
  AppManagementError,
  importMediaFile,
  installApk,
} from "./app-management.ts";
import {
  MultipartUploadError,
  stageMultipartUpload,
  type StagedMultipartFile,
} from "./multipart-upload.ts";
import { HttpBodyError } from "./request-body.ts";
import {
  UploadManager,
  UploadManagerError,
  type UploadManagerOptions,
} from "./upload-manager.ts";

const DEFAULT_MAX_APK_UPLOAD_BYTES = 512 * 1024 * 1024;
const DEFAULT_MAX_MEDIA_UPLOAD_BYTES = 1024 * 1024 * 1024;
const DEFAULT_MAX_ACTIVE_UPLOADS = 2;
const DEFAULT_MAX_QUEUED_UPLOADS = 4;
const DEFAULT_UPLOAD_QUEUE_TIMEOUT_MS = 5_000;
const MULTIPART_BODY_OVERHEAD_BYTES = 1024 * 1024;

type MiddlewareUploadOptions = {
  serial: string;
  maxApkUploadBytes?: number;
  maxMediaUploadBytes?: number;
  maxActiveUploads?: number;
  maxQueuedUploads?: number;
  uploadQueueTimeoutMs?: number;
};

type MiddlewareUploadDependencies = {
  stageMultipartUpload?: typeof stageMultipartUpload;
  installApk?: typeof installApk;
  importMediaFile?: typeof importMediaFile;
  createUploadManager?: (options: UploadManagerOptions) => UploadManager;
};

type UploadKind = "apk" | "file";

function uploadLimit(
  value: number | undefined,
  fallback: number,
  name: string,
  allowZero = false,
): number {
  const resolved = value ?? fallback;
  if (!Number.isSafeInteger(resolved) || resolved < (allowZero ? 0 : 1)) {
    throw new TypeError(
      `${name} must be ${allowZero ? "a non-negative" : "a positive"} safe integer`,
    );
  }
  return resolved;
}

function uploadErrorResponse(error: unknown): Response {
  let status = 400;
  let code: string | undefined;

  if (error instanceof HttpBodyError) {
    status = error.status;
    code = error.code;
  } else if (error instanceof MultipartUploadError) {
    status = error.status;
    code = error.code;
  } else if (error instanceof UploadManagerError) {
    const mapped = {
      "queue-full": { status: 429, code: "upload-queue-full" },
      "queue-timeout": { status: 503, code: "upload-queue-timeout" },
      "upload-cancelled": { status: 499, code: "upload-cancelled" },
      "device-session-changed": {
        status: 409,
        code: "device-session-changed",
      },
      closed: { status: 503, code: "upload-service-closed" },
    } as const;
    status = mapped[error.code].status;
    code = mapped[error.code].code;
  } else if (error instanceof AppManagementError) {
    status = error.code === "adb-timeout" ? 504 : 502;
    code = error.code;
  }

  return Response.json(
    {
      ok: false,
      ...(code ? { code } : {}),
      error: error instanceof Error ? error.message : String(error),
    },
    { status },
  );
}

async function cleanupStagedFile(
  staged: StagedMultipartFile,
  operationError: unknown,
): Promise<void> {
  try {
    await staged.cleanup();
  } catch (cleanupError) {
    throw new MultipartUploadError(
      "upload-cleanup-failed",
      "failed to clean up multipart upload",
      {
        cause:
          operationError === undefined
            ? cleanupError
            : new AggregateError([operationError, cleanupError]),
      },
    );
  }
}

/**
 * Fetch-compatible multipart upload boundary for the embeddable middleware.
 * Each request is streamed into a private temporary file and owns an upload
 * manager slot through the final ADB operation and staging-file cleanup.
 */
export function createMiddlewareUploader(
  options: MiddlewareUploadOptions,
  dependencies: MiddlewareUploadDependencies = {},
) {
  const maxApkUploadBytes = uploadLimit(
    options.maxApkUploadBytes,
    DEFAULT_MAX_APK_UPLOAD_BYTES,
    "maxApkUploadBytes",
  );
  const maxMediaUploadBytes = uploadLimit(
    options.maxMediaUploadBytes,
    DEFAULT_MAX_MEDIA_UPLOAD_BYTES,
    "maxMediaUploadBytes",
  );
  const maxActiveUploads = uploadLimit(
    options.maxActiveUploads,
    DEFAULT_MAX_ACTIVE_UPLOADS,
    "maxActiveUploads",
  );
  const maxQueuedUploads = uploadLimit(
    options.maxQueuedUploads,
    DEFAULT_MAX_QUEUED_UPLOADS,
    "maxQueuedUploads",
    true,
  );
  const uploadQueueTimeoutMs = uploadLimit(
    options.uploadQueueTimeoutMs,
    DEFAULT_UPLOAD_QUEUE_TIMEOUT_MS,
    "uploadQueueTimeoutMs",
    true,
  );
  const largestFileLimit = Math.max(
    maxApkUploadBytes,
    maxMediaUploadBytes,
  );
  if (
    largestFileLimit >
    Number.MAX_SAFE_INTEGER - MULTIPART_BODY_OVERHEAD_BYTES
  ) {
    throw new TypeError("upload byte limit is too large");
  }

  const stageUpload =
    dependencies.stageMultipartUpload ?? stageMultipartUpload;
  const installStagedApk = dependencies.installApk ?? installApk;
  const importStagedMedia = dependencies.importMediaFile ?? importMediaFile;
  const uploads = (
    dependencies.createUploadManager ??
    ((managerOptions: UploadManagerOptions) =>
      new UploadManager(managerOptions))
  )({
    maxActive: maxActiveUploads,
    maxQueued: maxQueuedUploads,
    queueTimeoutMs: uploadQueueTimeoutMs,
  });
  const context = { serial: options.serial, generation: 0 } as const;

  const handle = async (request: Request, kind: UploadKind) => {
    const fieldName = kind === "apk" ? "apk" : "file";
    const maxFileBytes =
      kind === "apk" ? maxApkUploadBytes : maxMediaUploadBytes;
    const action = kind === "apk" ? installStagedApk : importStagedMedia;

    try {
      const result = await uploads.run(
        { context, requestSignal: request.signal },
        async ({ signal }) => {
          const staged = await stageUpload(request, {
            fieldName,
            maxFileBytes,
            maxBodyBytes:
              maxFileBytes + MULTIPART_BODY_OVERHEAD_BYTES,
            signal,
          });
          let operationError: unknown;
          try {
            return await action(options.serial, staged, signal);
          } catch (error) {
            operationError = error;
            throw error;
          } finally {
            await cleanupStagedFile(staged, operationError);
          }
        },
      );
      return Response.json(result);
    } catch (error) {
      if (request.body && !request.body.locked) {
        await request.body.cancel(error).catch(() => {});
      }
      return uploadErrorResponse(error);
    }
  };

  return {
    install: (request: Request) => handle(request, "apk"),
    importFile: (request: Request) => handle(request, "file"),
    snapshot: () => uploads.snapshot(),
    close: (cause?: unknown) => uploads.close(cause),
  };
}
