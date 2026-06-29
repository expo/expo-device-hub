import type { CreateDeviceOptions } from "./types";

/**
 * Throw if a required {@link CreateDeviceOptions} field is empty.
 *
 * `name` and `deviceType` are required by `simctl create`; `runtime` is optional
 * (simctl picks a compatible runtime when it is omitted).
 */
export function assertCreateOptions(options: CreateDeviceOptions): void {
  if (!options.name || !options.name.trim()) {
    throw new Error("[apple-utils] `name` is required to create a simulator.");
  }
  if (!options.deviceType || !options.deviceType.trim()) {
    throw new Error(
      '[apple-utils] `deviceType` is required to create a simulator (e.g. "com.apple.CoreSimulator.SimDeviceType.iPhone-15").',
    );
  }
}

/**
 * Build the positional `simctl create <name> <deviceType> [<runtime>]` args.
 *
 * Throws via {@link assertCreateOptions} when a required field is empty. The
 * optional `runtime` is appended only when present.
 */
export function buildCreateArgs(options: CreateDeviceOptions): string[] {
  assertCreateOptions(options);

  const args = ["create", options.name, options.deviceType];
  if (options.runtime && options.runtime.trim()) args.push(options.runtime);

  return args;
}

/**
 * Extract the UDID `simctl create` prints on success.
 *
 * Returns the trimmed output, or `null` when it is empty. Never throws.
 */
export function parseCreatedUdid(stdout: string): string | null {
  const udid = stdout.trim();
  return udid.length > 0 ? udid : null;
}
