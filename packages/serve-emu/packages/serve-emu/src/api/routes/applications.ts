import {
  activityName,
  packageName,
  permissionName,
} from "../../app-management.ts";
import type { ApiDependencies } from "../dependencies.ts";
import {
  MAX_APK_MULTIPART_BYTES,
  MAX_MEDIA_MULTIPART_BYTES,
  readMultipartFormData,
} from "../multipart.ts";
import type { ContractApiRoute } from "./types.ts";
import {
  downstream,
  invalid,
  parseInput,
  readObject,
} from "./route-helpers.ts";

async function fileField(
  request: Request,
  field: string,
  maxBytes: number,
): Promise<File> {
  const form = await readMultipartFormData(request, maxBytes);
  const file = form.get(field);
  if (!(file instanceof File)) {
    invalid(`multipart field ${field} must be a file`);
  }
  return file;
}

export function applicationRoutes(): ContractApiRoute<ApiDependencies>[] {
  return [
    {
      method: "POST",
      path: "/api/apps/install",
      handler: async ({ request, deps }) => {
        const file = await fileField(request, "apk", MAX_APK_MULTIPART_BYTES);
        if (!file.name.toLowerCase().endsWith(".apk")) {
          invalid("APK file must end with .apk");
        }
        return Response.json(
          await downstream("install APK", () => deps.installApk(file)),
        );
      },
    },
    {
      method: "POST",
      path: "/api/files/import",
      handler: async ({ request, deps }) => {
        const file = await fileField(
          request,
          "file",
          MAX_MEDIA_MULTIPART_BYTES,
        );
        return Response.json(
          await downstream("import file", () => deps.importFile(file)),
        );
      },
    },
    {
      method: "POST",
      path: "/api/apps/launch",
      handler: async ({ request, deps }) => {
        const body = await readObject(request, "launch payload");
        const pkg = parseInput(() => packageName(body.packageName));
        const activity = typeof body.activity === "string" && body.activity.trim()
          ? parseInput(() => activityName(body.activity))
          : undefined;
        return Response.json(
          await downstream("launch app", () => deps.launchApp(pkg, activity)),
        );
      },
    },
    {
      method: "POST",
      path: "/api/apps/clear",
      handler: async ({ request, deps }) => {
        const body = await readObject(request, "clear payload");
        const pkg = parseInput(() => packageName(body.packageName));
        return Response.json(
          await downstream("clear app data", () => deps.clearApp(pkg)),
        );
      },
    },
    {
      method: "POST",
      path: "/api/apps/force-stop",
      handler: async ({ request, deps }) => {
        const body = await readObject(request, "force-stop payload");
        const pkg = parseInput(() => packageName(body.packageName));
        return Response.json(
          await downstream("force-stop app", () => deps.forceStopApp(pkg)),
        );
      },
    },
    {
      method: "POST",
      path: "/api/apps/grant",
      handler: async ({ request, deps }) => {
        const body = await readObject(request, "grant payload");
        const pkg = parseInput(() => packageName(body.packageName));
        const permission = parseInput(() => permissionName(body.permission));
        return Response.json(
          await downstream("grant app permission", () =>
            deps.grantPermission(pkg, permission)
          ),
        );
      },
    },
  ];
}
