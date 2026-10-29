import {
  DeviceKitChrome as SharedDeviceKitChrome,
  deviceKitChromeAssetPath,
  type DeviceKitChromeProps,
} from "@expo/hub-client";
import { simEndpoint } from "../utils/sim-endpoint";

export {
  deviceKitChromeForScreen,
  deviceKitChromeGeometry,
  deviceKitScreenRadius,
  snapChromeRect,
  type ChromeButtonPress,
} from "@expo/hub-client";

export function chromeAssetUrl(identifier: string, image: string): string {
  const path = deviceKitChromeAssetPath(identifier, image);
  return typeof window === "undefined" ? `/${path}` : simEndpoint(path);
}

export function DeviceKitChrome(props: Omit<DeviceKitChromeProps, "resolveAssetUrl">) {
  return <SharedDeviceKitChrome {...props} resolveAssetUrl={chromeAssetUrl} />;
}
