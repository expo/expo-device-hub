import { asRecord, type PermissionsBackend } from "./app-permissions";
import { type RunHostAction } from "./exec-ws";
import { type AppPermission } from "./types";

export function parseIosPermissions(payload: unknown): AppPermission[] {
  const entries = asRecord(payload)?.permissions;
  if (
    !Array.isArray(entries) ||
    !entries.every(
      (item) =>
        item &&
        typeof item.id === "string" &&
        typeof item.label === "string" &&
        ["granted", "denied", "limited", "undetermined"].includes(item.state),
    )
  ) {
    throw new Error("Invalid iOS permissions response. Update serve-sim on the host.");
  }
  return entries;
}

// @ref LLP 0013#app-permissions — stable per-host identity preserves reconnect locks without crossing hosts
export function iosPermissionTargetId(
  baseUrl: string | null | undefined,
  udid: string | null,
): string | null {
  return baseUrl && udid ? JSON.stringify([baseUrl, udid]) : null;
}

// @ref LLP 0013#app-permissions — read after writes; never infer state from an ACK
export function iosPermissionsBackend(run: RunHostAction, udid: string): PermissionsBackend {
  async function action(name: string, params: Parameters<RunHostAction>[1]) {
    const result = await run(name, { ...params, udid });
    if (result.exitCode !== 0) throw new Error(result.stderr.trim() || "Permission request failed");
    return result.stdout;
  }
  async function list(bundleId: string) {
    return parseIosPermissions(JSON.parse(await action("permissions.list", { bundleId })));
  }
  return {
    list,
    async write(bundleId, service, permissionAction) {
      await action("permissions.set", { bundleId, service, action: permissionAction });
      return list(bundleId);
    },
    async reset(bundleId) {
      await action("permissions.resetAll", { bundleId });
      return list(bundleId);
    },
  };
}
