import {
  adb,
  type AppActionResult,
  type AppManagementDependencies,
  packageName,
} from "./app-management.ts";
import type {
  AppPermissionsResponse,
  RuntimePermission,
} from "./shared/api-contracts.ts";

const BLOCK_HEADER = /^\s*runtime permissions:\s*$/;
const PERMISSION_LINE =
  /^\s*([A-Za-z][\w.]*): granted=(true|false)(?:, flags=\[([^\]]*)\])?/;

/** `dumpsys package` prints the runtime block once per user; the first entry per name wins. */
export function parseRuntimePermissions(dump: string): RuntimePermission[] {
  const byName = new Map<string, RuntimePermission>();
  let inBlock = false;
  for (const line of dump.split("\n")) {
    if (BLOCK_HEADER.test(line)) {
      inBlock = true;
      continue;
    }
    if (!inBlock) continue;
    const match = PERMISSION_LINE.exec(line);
    if (!match) {
      inBlock = false;
      continue;
    }
    const [, name, granted, flags = ""] = match;
    if (byName.has(name!)) continue;
    byName.set(name!, {
      name: name!,
      granted: granted === "true",
      flags: flags
        .split("|")
        .map((flag) => flag.trim())
        .filter(Boolean),
    });
  }
  return [...byName.values()];
}

export async function listPermissions(
  serial: string,
  packageNameValue: string,
  dependencies: AppManagementDependencies = {},
): Promise<AppPermissionsResponse> {
  const pkg = packageName(packageNameValue);
  const { output } = await adb(
    serial,
    ["shell", "dumpsys", "package", pkg],
    10_000,
    undefined,
    dependencies.execText,
  );
  return { ok: true, packageName: pkg, permissions: parseRuntimePermissions(output) };
}

/**
 * Per-package reset. `pm reset-permissions` is device-wide, so each runtime
 * permission returns to its manifest default (granted only when Android granted
 * it by default), user-decision flags are cleared, and app ops are reset.
 */
export async function resetPermissions(
  serial: string,
  packageNameValue: string,
  dependencies: AppManagementDependencies = {},
): Promise<AppActionResult> {
  const pkg = packageName(packageNameValue);
  const { permissions } = await listPermissions(serial, pkg, dependencies);
  const commands = permissions.flatMap(({ name, flags }) => [
    `pm ${flags.includes("GRANTED_BY_DEFAULT") ? "grant" : "revoke"} ${pkg} ${name}`,
    `pm clear-permission-flags ${pkg} ${name} user-set user-fixed`,
  ]);
  commands.push(`appops reset ${pkg}`);
  return adb(
    serial,
    ["shell", commands.join("; ")],
    30_000,
    undefined,
    dependencies.execText,
  );
}
