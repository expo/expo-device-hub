/** A single Android Virtual Device reported by `avdmanager list avd`. */
export interface AndroidDevice {
  /** The AVD name (the `Name:` field), used to launch the emulator. */
  name: string;
  /** Absolute path to the `.avd` directory (the `Path:` field), if present. */
  path: string | null;
  /** All `key: value` fields parsed from the `avdmanager` output block. */
  properties: Record<string, string>;
  /** Parsed `<path>/config.ini`; empty when it cannot be read. */
  config: Record<string, string>;
}
