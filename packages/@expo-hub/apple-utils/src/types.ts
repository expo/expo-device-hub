/** A single device entry as reported by `devicectl list devices`. */
export interface AppleDevice {
  /** Identifier devicectl assigns to the device for this discovery session. */
  identifier?: string;
  capabilities?: AppleDeviceCapability[];
  connectionProperties?: AppleConnectionProperties;
  deviceProperties?: AppleDeviceProperties;
  hardwareProperties?: AppleHardwareProperties;
  /** Any other fields emitted by devicectl are preserved as-is. */
  [key: string]: unknown;
}

export interface AppleDeviceCapability {
  featureIdentifier?: string;
  name?: string;
}

export interface AppleConnectionProperties {
  pairingState?: string;
  transportType?: string;
  tunnelState?: string;
  [key: string]: unknown;
}

export interface AppleDeviceProperties {
  name?: string;
  osVersionNumber?: string;
  bootState?: string;
  [key: string]: unknown;
}

export interface AppleHardwareProperties {
  udid?: string;
  platform?: string;
  deviceType?: string;
  marketingName?: string;
  [key: string]: unknown;
}
