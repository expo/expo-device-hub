import {
  asRecord,
  humanize,
  type PermissionsBackend,
  type PermissionsFetch,
  readPermissions,
} from "./app-permissions";
import { type AppPermission, type AppPermissionState } from "./types";

const STATES: readonly AppPermissionState[] = ["granted", "denied", "limited", "undetermined"];

export function parseIosPermissions(payload: unknown): AppPermission[] | null {
  const data = asRecord(payload);
  if (!data || data.ok !== true || !Array.isArray(data.permissions)) return null;
  const permissions: AppPermission[] = [];
  for (const entry of data.permissions) {
    const item = asRecord(entry);
    const state = item?.state;
    if (!item || typeof item.id !== "string" || !STATES.includes(state as AppPermissionState)) {
      return null;
    }
    permissions.push({ id: item.id, label: humanize(item.id), state: state as AppPermissionState });
  }
  return permissions;
}

export function iosPermissionsBackend(
  baseUrl: string,
  udid: string,
  fetchImpl: PermissionsFetch = fetch,
): PermissionsBackend {
  const url = `${baseUrl.replace(/\/$/, "")}/permissions?device=${encodeURIComponent(udid)}`;
  const post = async (body: Record<string, string>) => {
    const response = await fetchImpl(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
    return readPermissions(response, parseIosPermissions, "Permission update failed");
  };
  return {
    list: async (appId) => {
      const response = await fetchImpl(`${url}&bundleId=${encodeURIComponent(appId)}`, {
        cache: "no-store",
      });
      return readPermissions(response, parseIosPermissions, "Could not read permissions");
    },
    write: (appId, id, action) => post({ bundleId: appId, id, action }),
    reset: (appId) => post({ bundleId: appId, id: "all", action: "reset" }),
  };
}
