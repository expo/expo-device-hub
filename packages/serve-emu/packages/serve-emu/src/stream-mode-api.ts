import { ApiError, apiErrorResponse } from "./api/api-error.ts";
import { HttpBodyError } from "./request-body.ts";

function message(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

export function streamModeMethodNotAllowedResponse(): Response {
  return apiErrorResponse(
    new ApiError(405, "method_not_allowed", "Method must be GET or PUT", {
      headers: { Allow: "GET, PUT" },
    }),
  );
}

export function streamModeRequestErrorResponse(error: unknown): Response {
  if (
    error instanceof HttpBodyError &&
    (error.code === "payload-too-large" ||
      error.code === "too-many-body-chunks")
  ) {
    return apiErrorResponse(
      new ApiError(413, "payload_too_large", error.message, { cause: error }),
    );
  }
  if (error instanceof HttpBodyError && error.code === "invalid-json") {
    return apiErrorResponse(
      new ApiError(400, "invalid_json", error.message, { cause: error }),
    );
  }
  return apiErrorResponse(
    new ApiError(400, "invalid_request", message(error), { cause: error }),
  );
}

export function streamModeUnavailableResponse(error: unknown): Response {
  return apiErrorResponse(
    new ApiError(503, "service_unavailable", message(error), { cause: error }),
  );
}

export function streamModeConflictResponse(error: unknown): Response {
  return apiErrorResponse(
    new ApiError(409, "conflict", message(error), { cause: error }),
  );
}
