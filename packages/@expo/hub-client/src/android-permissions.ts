import { deviceApiUrl } from "./android-api-url";
import {
  asRecord,
  errorMessage,
  humanize,
  type PermissionsBackend,
  type PermissionsFetch,
  readPermissions,
} from "./app-permissions";
import { type AppPermission, type AppPermissionAction } from "./types";

const PREFIX = "android.permission.";

/** One accepted `GET /api/apps/permissions` payload. */
export function parseAndroidPermissions(payload: unknown): AppPermission[] | null {
  const data = asRecord(payload);
  if (!data || data.ok !== true || !Array.isArray(data.permissions)) return null;
  const permissions: AppPermission[] = [];
  for (const entry of data.permissions) {
    const item = asRecord(entry);
    if (!item || typeof item.name !== "string" || typeof item.granted !== "boolean") return null;
    permissions.push({
      id: item.name,
      label: humanize(item.name.startsWith(PREFIX) ? item.name.slice(PREFIX.length) : item.name),
      state: item.granted ? "granted" : "denied",
    });
  }
  return permissions;
}

const WRITE_PATH: Record<AppPermissionAction, string> = {
  grant: "/api/apps/grant",
  revoke: "/api/apps/revoke",
};

/** serve-emu writes reply with adb output only, so each write reads the list back. */
export function androidPermissionsBackend(
  baseUrl: string,
  device: string | null,
  fetchImpl: PermissionsFetch = fetch,
): PermissionsBackend {
  const list = async (appId: string) => {
    const path = `/api/apps/permissions?packageName=${encodeURIComponent(appId)}`;
    const response = await fetchImpl(deviceApiUrl(baseUrl, path, device), { cache: "no-store" });
    return readPermissions(response, parseAndroidPermissions, "Could not read permissions");
  };
  const post = async (path: string, body: Record<string, string>) => {
    const response = await fetchImpl(deviceApiUrl(baseUrl, path, device), {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
    if (response.ok) return;
    const payload: unknown = await response.json().catch(() => null);
    throw new Error(errorMessage(payload, "Permission update failed"));
  };
  return {
    list,
    write: async (appId, id, action) => {
      await post(WRITE_PATH[action], { packageName: appId, permission: id });
      return list(appId);
    },
    reset: async (appId) => {
      await post("/api/apps/reset-permissions", { packageName: appId });
      return list(appId);
    },
  };
}
