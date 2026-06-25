/** A single line of `adb devices -l` output. */
export interface AdbDevice {
  /** The device serial (e.g. `"emulator-5554"` or `"27151JEGR11854"`). */
  serial: string;
  /** The connection state: `"device"`, `"offline"`, `"unauthorized"`, … */
  state: string;
  /** Trailing `key:value` fields (e.g. `product`, `model`, `transport_id`). */
  fields: Record<string, string>;
}

const HEADER = "List of devices attached";

/**
 * Parse the output of `adb devices -l` into one entry per attached device.
 *
 * The header line, blank lines, and `* daemon …` status lines are ignored.
 * Never throws.
 */
export function parseAdbDevices(stdout: string): AdbDevice[] {
  const devices: AdbDevice[] = [];

  for (const rawLine of stdout.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line || line === HEADER || line.startsWith("*")) continue;

    const [serial, state, ...rest] = line.split(/\s+/);
    if (!serial || !state) continue;

    devices.push({ serial, state, fields: parseFields(rest) });
  }

  return devices;
}

/** Whether a device is online and ready for commands (`state === "device"`). */
export function isOnline(device: AdbDevice): boolean {
  return device.state === "device";
}

function parseFields(tokens: string[]): Record<string, string> {
  const fields: Record<string, string> = {};

  for (const token of tokens) {
    const separator = token.indexOf(":");
    if (separator <= 0) continue;

    fields[token.slice(0, separator)] = token.slice(separator + 1);
  }

  return fields;
}
