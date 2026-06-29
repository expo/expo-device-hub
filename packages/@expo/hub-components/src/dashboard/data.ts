/**
 * Shared types + static UI config for the Expo Hub dashboard components.
 *
 * Device lists come live from the consumer (e.g. the Hub plugin server via a
 * `useDevices` hook); this module only holds the shared shapes the presentational
 * components are typed against, plus the static `tabs` config.
 */

export type Platform = 'ios' | 'android';

export type Device = {
  id: string;
  name: string;
  version: string;
  platform: Platform;
  /** Whether the device is currently booted / running. */
  booted: boolean;
  /**
   * Whether this is real physical hardware rather than a simulator/emulator.
   * Physical devices can't be erased, so the "Erase" control is hidden for them.
   */
  physical: boolean;
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

export type TabKey = 'logs' | 'network' | 'settings';

/**
 * Active UI color scheme. The consumer owns how it's resolved (system setting +
 * override); the components just read it and render light/dark accordingly.
 */
export type ColorScheme = 'light' | 'dark';

/** OS versions + device models offered in the add-device picker's "New <kind>" form. */
export type NewDeviceOptions = {
  /** OS versions for the select, newest first. e.g. "iOS 27.0". */
  osVersions: string[];
  /** Device models for the select. e.g. "iPhone 17 Pro". */
  models: string[];
};

export const tabs: { key: TabKey; label: string }[] = [
  { key: 'logs', label: 'Logs' },
  { key: 'network', label: 'Network' },
  { key: 'settings', label: 'Settings' },
];
