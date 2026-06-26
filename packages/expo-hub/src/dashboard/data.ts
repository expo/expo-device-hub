/**
 * Static data for the Expo Hub dashboard. The device lists are no longer mocked
 * here — they come live from the plugin server via `useDevices`; this file now
 * only holds the shared types and the static `logs` / `tabs` placeholders.
 */

export type Platform = 'ios' | 'android';

export type Device = {
  id: string;
  name: string;
  version: string;
  platform: Platform;
  /** Whether the device is currently booted / running. */
  booted: boolean;
};

export type LogEntry = {
  id: string;
  /** Short source tag rendered as a monospace chip, e.g. `server`. */
  source: string;
  message: string;
};

export type TabKey = 'logs' | 'network' | 'settings';

export const logs: LogEntry[] = [
  { id: '1', source: 'server', message: 'expo-image@2.4.0 - expected version: ~2.4.1' },
  { id: '2', source: 'server', message: 'expo-router@5.1.5 - expected version: ~5.1.7' },
  { id: '3', source: 'server', message: 'react-native@0.79.5 - expected version: ~0.79.6' },
  { id: '4', source: 'server', message: 'waiting on http://localhost:8081' },
  { id: '5', source: 'server', message: 'Connected @ 18:54:04' },
  { id: '6', source: 'server', message: 'Attached – streaming /home/user/tmp/expo.log' },
  { id: '7', source: 'metro', message: 'Bundling index.ts (entry point)' },
  { id: '8', source: 'metro', message: 'iOS bundled 1284 modules in 3.2s' },
  { id: '9', source: 'metro', message: 'Refreshing JS bundle (Fast Refresh)' },
  { id: '10', source: 'device', message: 'Reloading app on iPhone 17 Pro' },
  { id: '11', source: 'device', message: 'JS engine: Hermes 0.12.0' },
  { id: '12', source: 'server', message: 'GET /symbolicate 200 14ms' },
  { id: '13', source: 'server', message: 'GET /assets/icon.png 200 2ms' },
  { id: '14', source: 'metro', message: 'iOS bundled 6 modules in 0.4s' },
  { id: '15', source: 'device', message: 'console.log: app mounted' },
  { id: '16', source: 'server', message: 'Heartbeat ok @ 18:54:21' },
  { id: '17', source: 'server', message: 'Heartbeat ok @ 18:54:36' },
  { id: '18', source: 'server', message: 'Heartbeat ok @ 18:54:51' },
];

export const tabs: { key: TabKey; label: string }[] = [
  { key: 'logs', label: 'Logs' },
  { key: 'network', label: 'Network' },
  { key: 'settings', label: 'Settings' },
];
