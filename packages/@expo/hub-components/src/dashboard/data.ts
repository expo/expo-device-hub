/**
 * Shared types + static UI config for the Expo Hub dashboard components.
 *
 * Device lists come live from the consumer (e.g. the Hub plugin server via a
 * `useDevices` hook); this module only holds the shared shapes the presentational
 * components are typed against.
 */

export type Platform = 'ios' | 'android';

/** Device-frame artwork bundled by Hub for a known phone family. */
export type DeviceFrameKind = 'iphone' | 'pixel';

export type Device = {
  id: string;
  name: string;
  version: string;
  platform: Platform;
  /** Whether the device is currently booted / running. */
  booted: boolean;
  /**
   * Whether this is real physical hardware rather than a simulator/emulator.
   * Physical devices can't be removed, so the "Remove" control is hidden for them.
   */
  physical: boolean;
  /** Whether this device type is in the set currently supported and tested by Hub. */
  supported: boolean;
  /** Frame artwork available for this exact device model, or null when none is available. */
  deviceFrame: DeviceFrameKind | null;
  /**
   * Epoch ms the device was last used. Drives the relative "Recents" time in the
   * add-device picker.
   */
  lastUsedAt?: number;
};

export type LogEntry = {
  id: string;
  /** Short source tag rendered as a monospace chip, e.g. `server`. */
  source: string;
  message: string;
};

/**
 * Active UI color scheme. The consumer owns how it's resolved (system setting +
 * override); the components just read it and render light/dark accordingly.
 */
export type ColorScheme = 'light' | 'dark';

/** A host toolchain device type/profile that can be used to create a device. */
export type NewDeviceModelOption = {
  /** Stable identifier passed to `simctl` / `avdmanager`. */
  value: string;
  /** Human-readable model name shown in the picker. */
  label: string;
  /** Whether this model is in the set currently supported and tested by Hub. */
  supported: boolean;
  /** Frame artwork available for this model, or null when none is available. */
  deviceFrame: DeviceFrameKind | null;
};

/** An installed runtime/system image and the models it can create. */
export type NewDeviceRuntimeOption = {
  /** Runtime identifier (iOS) or system-image package (Android). */
  value: string;
  /** Human-readable OS/image name shown in the picker. */
  label: string;
  /** Models compatible with this runtime/image. */
  models: NewDeviceModelOption[];
};

/** Real host toolchain options for the add-device picker's new-device form. */
export type NewDeviceOptions = {
  runtimes: NewDeviceRuntimeOption[];
};

/** Values required by the host to create and boot a new virtual device. */
export type NewDeviceRequest = {
  platform: Platform;
  name: string;
  /** Runtime identifier (iOS) or system-image package (Android). */
  runtime: string;
  /** Simulator device-type identifier (iOS) or AVD device-profile id (Android). */
  deviceType: string;
  /** Human-readable OS label retained for the sidebar after creation. */
  version: string;
  /** Whether the selected model is currently supported and tested by Hub. */
  supported: boolean;
  /** Frame artwork available for the selected model, or null when none is available. */
  deviceFrame: DeviceFrameKind | null;
};

/** The mutually exclusive target selected in the add-device picker. */
export type AddDeviceTarget =
  | { kind: 'recent'; device: Device }
  | { kind: 'new'; device: NewDeviceRequest };

/** Result returned to the picker after its async boot/create request. */
export type AddDeviceOutcome = { ok: true } | { ok: false; error: string };
