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
/** `adb shell` exits with the last command's status, so each command marks its own failure. */
const FAILED = "PERMISSION_RESET_FAILED:";
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
 * Per package: `pm reset-permissions` is device-wide. Permissions already at their default are
 * left alone because every `pm revoke` stops the app.
 */
export async function resetPermissions(
  serial: string,
  packageNameValue: string,
  dependencies: AppManagementDependencies = {},
): Promise<AppActionResult> {
  const pkg = packageName(packageNameValue);
  const { permissions } = await listPermissions(serial, pkg, dependencies);
  const commands = permissions.flatMap(({ name, granted, flags }) => {
    const grantedByDefault = flags.includes("GRANTED_BY_DEFAULT");
    const change = grantedByDefault ? "grant" : "revoke";
    return [
      ...(granted === grantedByDefault ? [] : [`pm ${change} ${pkg} ${name}`]),
      `pm clear-permission-flags ${pkg} ${name} user-set user-fixed`,
    ];
  });
  commands.push(`appops reset ${pkg}`);
  const result = await adb(
    serial,
    ["shell", commands.map((command) => `${command} || echo '${FAILED} ${command}'`).join("; ")],
    30_000,
    undefined,
    dependencies.execText,
  );
  const failed = result.output.split("\n").filter((line) => line.startsWith(FAILED));
  if (failed.length > 0) throw new Error(`Permission reset failed: ${failed.join("; ")}`);
  return result;
}
