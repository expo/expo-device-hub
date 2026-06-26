/**
 * Options for the "New simulator" / "New emulator" form in the add-device
 * picker — the OS versions and device models offered in the two selects.
 *
 * MOCKED for now. Eventually these come from the host toolchain:
 *   - iOS: `xcrun simctl list runtimes` (OS versions) + `… devicetypes` (models)
 *   - Android: `avdmanager list` (system images + device definitions)
 * Until that wiring exists, the picker is fed this hard-coded set so the form is
 * fully interactive. The shape is per-platform so the Simulators section gets
 * iOS options and the Emulators section gets Android ones.
 */

export type NewDevicePlatform = 'ios' | 'android';

export interface NewDeviceOptions {
  /** OS versions for the select, newest first. e.g. "iOS 27.0". */
  osVersions: string[];
  /** Device models for the select. e.g. "iPhone 17 Pro". */
  models: string[];
}

export interface NewDeviceOptionsByPlatform {
  ios: NewDeviceOptions;
  android: NewDeviceOptions;
}

/** Hard-coded stand-in until real runtime/device-type discovery is wired up. */
export const MOCK_NEW_DEVICE_OPTIONS: NewDeviceOptionsByPlatform = {
  ios: {
    osVersions: ['iOS 27.0', 'iOS 26.5', 'iOS 18.6', 'iOS 18.0'],
    models: [
      'iPhone 17 Pro',
      'iPhone 17',
      'iPhone 16 Pro',
      'iPhone 16',
      'iPhone SE (3rd generation)',
      'iPad Pro 13-inch (M4)',
      'iPad mini (A17 Pro)',
    ],
  },
  android: {
    osVersions: ['Android 16.0', 'Android 15.0', 'Android 14.0', 'Android 13.0'],
    models: ['Pixel 9 Pro', 'Pixel 9', 'Pixel 8', 'Pixel 7', 'Pixel Tablet'],
  },
};
