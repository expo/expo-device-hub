const PROP_LINE = /^\[(.+?)\]:\s*\[(.*)\]$/;

/** The `getprop` keys surfaced for physical devices, in display order. */
export const PHYSICAL_PROP_KEYS = [
  "ro.product.model",
  "ro.product.manufacturer",
  "ro.build.version.release",
  "ro.build.version.sdk",
  "ro.build.display.id",
] as const;

/**
 * Parse the output of `adb shell getprop` (lines of `[key]: [value]`).
 *
 * Lines that do not match the `[key]: [value]` shape are ignored. Values may be
 * empty. Never throws.
 */
export function parseGetprop(stdout: string): Record<string, string> {
  const props: Record<string, string> = {};

  for (const rawLine of stdout.split(/\r?\n/)) {
    const match = PROP_LINE.exec(rawLine.trim());
    if (!match) continue;

    const [, key, value] = match;
    if (key === undefined) continue;

    props[key] = value ?? "";
  }

  return props;
}

/**
 * Whether the parsed `getprop` values describe an emulator.
 *
 * `ro.kernel.qemu` is `1` on emulators; `ro.boot.qemu` is checked as a fallback
 * for images that no longer expose the kernel prop.
 */
export function isEmulatorProps(props: Record<string, string>): boolean {
  return props["ro.kernel.qemu"] === "1" || props["ro.boot.qemu"] === "1";
}

/** Pick the curated subset of `getprop` values surfaced for physical devices. */
export function pickPhysicalProps(props: Record<string, string>): Record<string, string> {
  const picked: Record<string, string> = {};

  for (const key of PHYSICAL_PROP_KEYS) {
    const value = props[key];
    if (value !== undefined) picked[key] = value;
  }

  return picked;
}
