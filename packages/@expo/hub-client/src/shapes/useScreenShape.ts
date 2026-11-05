import { useState } from "react";

import { displayScreen } from "../orientation";
import {
  type DeviceClient,
  type DeviceDisplayId,
  type DeviceOrientation,
  type DevicePlatform,
  type ScreenSize,
} from "../types";
import { resolveScreenShape } from "./catalog";
import { rotateScreenShape, type ScreenShape, screenShapeOrientation } from "./screen-shape";

/**
 * The parts of a device client that a screen shape follows. A `DeviceClient`
 * gives all of them; a `DeviceScreenClient` gives only the screen, so pass
 * `platform` and `model` with it.
 */
export type ScreenShapeClient = Pick<DeviceClient, "screen"> &
  Partial<Pick<DeviceClient, "platform" | "devices">>;

/**
 * Where a screen shape comes from. With `client`, the shape follows the
 * client's platform, device, display, and orientation. Every other field
 * overrides the client's value; without a client, the fields are the only
 * source.
 */
export interface ScreenShapeSource {
  client?: ScreenShapeClient | null;
  platform?: DevicePlatform;
  /**
   * The device model, as {@link resolveScreenShape} takes it. Defaults to the
   * name of the client's current device, which a simulator reports late or
   * not at all; pass the model when you know it.
   */
  model?: string | null;
  /** The display shown, for a device with a shape per display. Defaults to the client's. */
  display?: DeviceDisplayId;
  /** The device orientation. Defaults to the client's screen, else portrait. */
  orientation?: DeviceOrientation;
  /**
   * A portrait shape to use instead of the looked-up one, such as a custom
   * device's. It still turns with `orientation`. `null` means no shape.
   */
  shape?: ScreenShape | null;
}

function currentDevice(client: ScreenShapeClient | null | undefined) {
  return client?.devices?.find((device) => device.current) ?? null;
}

/**
 * The device whose last screen a shape may keep: the client's current device,
 * or the model passed for it. Without a client, nothing is kept.
 */
function screenSourceKey(source: ScreenShapeSource): string | null {
  if (!source.client) return null;
  const device = currentDevice(source.client);
  return [
    source.platform ?? source.client.platform ?? "",
    source.model ?? device?.name ?? "",
    device?.id ?? "",
  ].join("\u0000");
}

/** The shape as the viewer sees it, for a source and the screen it last reported. */
function shownScreenShape(
  source: ScreenShapeSource,
  screen: ScreenSize | null,
): ScreenShape | null {
  const platform = source.platform ?? source.client?.platform;
  const portrait =
    source.shape !== undefined
      ? source.shape
      : platform
        ? resolveScreenShape({
            platform,
            model: source.model ?? currentDevice(source.client)?.name,
            display: source.display ?? screen?.display,
            screen,
          })
        : null;
  if (!portrait) return null;
  return rotateScreenShape(
    portrait,
    source.orientation ?? screenShapeOrientation(displayScreen(screen)),
  );
}

// @ref LLP 0017#displays-and-orientation — the kept screen belongs to one device, never to the next
/**
 * The screen shape of a device as the viewer sees it: looked up from its model,
 * on the display it shows, turned with the device. Null for an unknown model.
 * While the client reports no screen for the same device, such as while it
 * reconnects or after the session ends, the shape keeps the last display and
 * orientation it had. Another device or model, or no client, starts over.
 */
export function useScreenShape(source: ScreenShapeSource): ScreenShape | null {
  const screen = source.client?.screen ?? null;
  const key = screenSourceKey(source);
  const [kept, setKept] = useState({ key, screen });
  if (kept.key !== key || (screen && screen !== kept.screen)) setKept({ key, screen });
  const lastScreen = kept.key === key ? kept.screen : null;
  return shownScreenShape(source, screen ?? lastScreen);
}
