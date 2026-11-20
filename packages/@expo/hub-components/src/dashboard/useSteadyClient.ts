import { type DeviceCapabilities, type DeviceClient } from "@expo/hub-client";
import { useEffect, useMemo, useState } from "react";

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

/** What a device takes from the last device of its kind until it has reported for itself. */
type Guess = Pick<Kept, "capabilities" | "streamCapabilities">;

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
 * What a device without a report and without a guess can do. Logs and the foreground app count as
 * present, as the client reports them, so their sections do not say "not available" while the
 * first device connects.
 */
const NO_CAPABILITIES: DeviceCapabilities = {
  deviceSettings: false,
  activity: false,
  events: false,
  logs: true,
  foregroundApp: true,
  camera: false,
  accessibility: false,
  streamSettings: false,
  location: false,
  permissions: false,
  clipboard: false,
  orientation: false,
  fold: false,
};

/**
 * How long a device that streams can still take a capability from the last
 * device of its kind. A client reads some capabilities after its stream
 * starts, such as the location support of an Android device, and it reports
 * one that it has not read yet like one that the device does not have. After
 * this time, only the device's own reports count.
 */
export const GUESS_GRACE_MS = 5000;

/**
 * Whether two reported values hold the same data. A client can build an equal
 * object again on each render, and a command inside it is not data, so the
 * comparison is by content.
 */
function sameData(a: unknown, b: unknown): boolean {
  return a === b || JSON.stringify(a) === JSON.stringify(b);
}

const PRESENT_UNTIL_REPORTED: ReadonlySet<keyof DeviceCapabilities> = new Set([
  "logs",
  "foregroundApp",
]);

/**
 * The capabilities of `first`, with each one that it lacks from `second`. It
 * is `first` itself when `second` adds nothing.
 */
function withCapabilities(
  first: DeviceCapabilities,
  second: DeviceCapabilities | undefined,
): DeviceCapabilities {
  if (!second) return first;
  const merged = { ...first } as Record<keyof DeviceCapabilities, unknown>;
  let changed = false;
  for (const key of Object.keys(second) as (keyof DeviceCapabilities)[]) {
    const value = PRESENT_UNTIL_REPORTED.has(key) ? first[key] : first[key] || second[key];
    if (!sameData(value, first[key])) {
      changed = true;
      merged[key] = value;
    }
  }
  return changed ? (merged as DeviceCapabilities) : first;
}

/** Each capability that the device reported once stays, with its last value, except logs and the foreground app. */
function keepCapabilities(
  previous: DeviceCapabilities | undefined,
  live: DeviceCapabilities,
): DeviceCapabilities {
  if (!previous) return live;
  const merged = { ...previous } as Record<keyof DeviceCapabilities, unknown>;
  let changed = false;
  for (const key of Object.keys(live) as (keyof DeviceCapabilities)[]) {
    const value = PRESENT_UNTIL_REPORTED.has(key) ? live[key] : live[key] || previous[key];
    if (!sameData(value, previous[key])) {
      changed = true;
      merged[key] = value;
    }
  }
  return changed ? (merged as DeviceCapabilities) : previous;
}

/** The device's own reports after this one. It is `previous` itself while the client reports the same data. */
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
 * Devices of one kind have the same sections: a simulator can do what another
 * simulator can, but a physical phone cannot do what an emulator can.
 */
function deviceKind(device: { platform: Platform; physical?: boolean }): string {
  return `${device.platform}:${device.physical ? "physical" : "virtual"}`;
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
 *
 * A device that has not reported yet starts with a guess: the capabilities of
 * the last device of its kind that streamed, so that its sections are in place
 * before it connects. The guess ends {@link GUESS_GRACE_MS} after the device
 * streams. From then on only its own reports count, so a control that the
 * device does not have does not stay.
 */
// @ref LLP 0000#steady-inspector — kept values are for the layout only; commands and lock reasons stay live
export function useSteadyClient(
  client: DeviceClient | undefined,
  device: { id: string; platform: Platform; physical?: boolean } | undefined,
): SteadyClient | undefined {
  const [keptByDevice, setKeptByDevice] = useState<ReadonlyMap<string, Kept>>(() => new Map());
  const [guessByKind, setGuessByKind] = useState<ReadonlyMap<string, Guess>>(() => new Map());
  const deviceId = device?.id;

  // The device that the client's reports belong to. In the render that selects
  // another device, the client still holds the reports of the device before:
  // its adapter clears them in an effect. Those reports are not this device's.
  const [reportingDevice, setReportingDevice] = useState(deviceId);
  useEffect(() => setReportingDevice(deviceId), [deviceId]);
  const reporting = reportingDevice === deviceId;

  // The devices whose guess has ended.
  const [settled, setSettled] = useState<ReadonlySet<string>>(() => new Set());
  const streaming = client?.status === "streaming";
  const guessing = deviceId !== undefined && !settled.has(deviceId);
  useEffect(() => {
    if (deviceId === undefined || !streaming || !guessing) return;
    const timer = setTimeout(
      () => setSettled((devices) => new Set(devices).add(deviceId)),
      GUESS_GRACE_MS,
    );
    return () => clearTimeout(timer);
  }, [deviceId, streaming, guessing]);

  const own = deviceId === undefined ? undefined : keptByDevice.get(deviceId);
  const kept = client && reporting ? keep(own, client) : own;
  // Storing what an earlier render saw is the one case where a render sets state.
  if (deviceId !== undefined && kept && kept !== own) {
    setKeptByDevice(new Map(keptByDevice).set(deviceId, kept));
  }

  const kind = device ? deviceKind(device) : undefined;
  const kindGuess = kind === undefined ? undefined : guessByKind.get(kind);
  const guess = guessing ? kindGuess : undefined;
  const ownCapabilities = kept?.capabilities;
  const guessCapabilities = guess?.capabilities;
  const capabilities = useMemo(
    () =>
      // A fold belongs to one device and is not passed on.
      withCapabilities(
        ownCapabilities ?? NO_CAPABILITIES,
        guessCapabilities && { ...guessCapabilities, fold: false },
      ),
    [ownCapabilities, guessCapabilities],
  );
  const streamCapabilities = kept?.streamCapabilities ?? guess?.streamCapabilities ?? null;
  // What this device shows is the guess for the next device of its kind. Only a
  // device that streams has read its capabilities. While this device still
  // guesses, the last guess stays in what it shows, so the guess is not lost.
  if (
    kind !== undefined &&
    reporting &&
    streaming &&
    !(
      sameData(capabilities, kindGuess?.capabilities) &&
      sameData(streamCapabilities, kindGuess?.streamCapabilities)
    )
  ) {
    setGuessByKind(new Map(guessByKind).set(kind, { capabilities, streamCapabilities }));
  }

  if (!client || !device) return client ? { client, stale: NOTHING_STALE } : undefined;

  // A value that the client reports now is used as it is: it can hold live commands.
  const steady = { ...client, capabilities } as {
    -readonly [Field in keyof DeviceClient]: DeviceClient[Field];
  };
  const stale = new Set<SteadyField>();
  for (const field of STEADY_FIELDS) {
    const live = reporting ? client[field] : null;
    // Of another device's values, only the stream capabilities are a guess: they belong to the platform.
    const fallback = field === "streamCapabilities" ? streamCapabilities : kept?.[field];
    (steady as Record<SteadyField, unknown>)[field] = live ?? fallback ?? null;
    if (live == null && fallback != null) stale.add(field);
  }
  return { client: steady, stale: stale.size > 0 ? stale : NOTHING_STALE };
}
