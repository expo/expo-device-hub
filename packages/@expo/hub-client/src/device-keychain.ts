import { type DeviceClient } from "./types";

const KEYCHAIN_UNAVAILABLE = "Keychain access is unavailable on this device.";

const unavailable = () => Promise.reject(new Error(KEYCHAIN_UNAVAILABLE));

/** Keychain fields of a client whose backend has none, with stable identities across renders. */
export const NO_KEYCHAIN = {
  listKeychainKeys: unavailable,
  setKeychainValues: unavailable,
  deleteKeychainValues: unavailable,
} satisfies Pick<DeviceClient, "listKeychainKeys" | "setKeychainValues" | "deleteKeychainValues">;
