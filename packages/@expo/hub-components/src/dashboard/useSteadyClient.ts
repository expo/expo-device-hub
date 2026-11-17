import { type DeviceCapabilities, type DeviceClient } from "@expo/hub-client";
import { useState } from "react";

import { type Platform } from "./data";

/**
 * The fields of a client that decide which rows the inspector shows and what
 * they hold. A client reports them as absent while it connects, and again each
 * time it reconnects.
 */
const STEADY_FIELDS = [
  "deviceSettings",
  "streamCapabilities",
  "streamSettings",
  "streamSource",
  "orientation",
  "fold",
  "displayWidthDp",
] as const;

export type SteadyField = (typeof STEADY_FIELDS)[number];

type Kept = Pick<DeviceClient, SteadyField | "capabilities">;

export type SteadyClient = {
  /**
   * The client, with the last reported value in place of each absent one. Its
   * commands and the fields that say whether a control can be used now, such as
   * `deviceSettingsStatus` and `orientationUnavailable`, are the live ones.
   */
  client: DeviceClient;
  /** The fields that hold a kept value, because the client reports none now. */
  stale: ReadonlySet<SteadyField>;
};

const NOTHING_STALE: ReadonlySet<SteadyField> = new Set();

/**
 * Whether two reported values hold the same data. A client can build an equal
 * object again on each render, and a command inside it is not data, so the
 * comparison is by content.
 */
function sameData(a: unknown, b: unknown): boolean {
  return a === b || JSON.stringify(a) === JSON.stringify(b);
}

/** Each capability that the client reported once stays, with its last value. */
function keepCapabilities(
  previous: DeviceCapabilities | undefined,
  live: DeviceCapabilities,
): DeviceCapabilities {
  if (!previous) return live;
  const merged = { ...previous } as Record<keyof DeviceCapabilities, unknown>;
  let changed = false;
  for (const key of Object.keys(live) as (keyof DeviceCapabilities)[]) {
    const value = live[key] || previous[key];
    if (!sameData(value, previous[key])) {
      changed = true;
      merged[key] = value;
    }
  }
  return changed ? (merged as DeviceCapabilities) : previous;
}

/** The kept values after this report. It is `previous` itself while the client reports the same data. */
function keep(previous: Kept | undefined, client: DeviceClient): Kept {
  const next = { capabilities: keepCapabilities(previous?.capabilities, client.capabilities) } as {
    -readonly [Field in keyof Kept]: Kept[Field];
  };
  let changed = !previous || next.capabilities !== previous.capabilities;
  for (const field of STEADY_FIELDS) {
    const value = client[field] ?? previous?.[field] ?? null;
    const same = !!previous && sameData(value, previous[field]);
    (next as Record<SteadyField, unknown>)[field] = same ? previous[field] : value;
    if (!same) changed = true;
  }
  return changed || !previous ? next : previous;
}

/**
 * What a device that has not reported yet starts with: the capabilities of the
 * last device of its platform, so that its sections are in place before it
 * connects. A fold belongs to one device and is not passed on.
 */
function firstGuess(platformKept: Kept | undefined): Kept | undefined {
  if (!platformKept) return undefined;
  return {
    capabilities: { ...platformKept.capabilities, fold: false },
    streamCapabilities: platformKept.streamCapabilities,
    deviceSettings: null,
    streamSettings: null,
    streamSource: null,
    orientation: null,
    fold: null,
    displayWidthDp: null,
  };
}

/**
 * The client that the inspector lays itself out with.
 *
 * An inspector that follows the live client adds and removes its sections and
 * rows each time the device connects or reconnects, because the client then
 * reports its capabilities and settings as absent. This hook keeps, for each
 * device, the last value that its client reported for those fields, and
 * returns the client with them filled in. A row then stays in place with its
 * last value, and `stale` tells the section to lock it until the client
 * reports again.
 */
// @ref LLP 0000#steady-inspector — kept values are for the layout only; commands and lock reasons stay live
export function useSteadyClient(
  client: DeviceClient | undefined,
  device: { id: string; platform: Platform } | undefined,
): SteadyClient | undefined {
  const [keptByDevice, setKeptByDevice] = useState<ReadonlyMap<string, Kept>>(() => new Map());
  const [keptByPlatform, setKeptByPlatform] = useState<ReadonlyMap<Platform, Kept>>(
    () => new Map(),
  );
  if (!client || !device) return client ? { client, stale: NOTHING_STALE } : undefined;

  const previous = keptByDevice.get(device.id) ?? firstGuess(keptByPlatform.get(device.platform));
  const kept = keep(previous, client);
  // Storing what an earlier render saw is the one case where a render sets state.
  if (kept !== keptByDevice.get(device.id)) {
    setKeptByDevice(new Map(keptByDevice).set(device.id, kept));
  }
  const platformKept = keptByPlatform.get(device.platform);
  if (
    kept.capabilities !== platformKept?.capabilities ||
    kept.streamCapabilities !== platformKept?.streamCapabilities
  ) {
    setKeptByPlatform(new Map(keptByPlatform).set(device.platform, kept));
  }

  // A value that the client reports now is used as it is: it can hold live commands.
  const steady = { ...client, capabilities: kept.capabilities } as {
    -readonly [Field in keyof DeviceClient]: DeviceClient[Field];
  };
  const stale = new Set<SteadyField>();
  for (const field of STEADY_FIELDS) {
    if (client[field] == null && kept[field] != null) {
      (steady as Record<SteadyField, unknown>)[field] = kept[field];
      stale.add(field);
    }
  }
  return { client: steady, stale: stale.size > 0 ? stale : NOTHING_STALE };
}
