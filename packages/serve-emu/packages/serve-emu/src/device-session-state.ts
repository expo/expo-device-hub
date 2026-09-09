import type { Gesture } from "./input.ts";
import type { GeoFix } from "./location.ts";
import { LogcatHub } from "./logcat.ts";
import {
  RoutePlayback,
  type RoutePlaybackClock,
} from "./route-playback.ts";
import {
  SessionRecorder,
  SessionReplayConflictError,
  type ReplayHandlers,
} from "./session-recorder.ts";

type DeviceStateOwner = object;

type ReplayInputTarget = {
  dispatchGesture(
    gesture: Gesture,
    signal: AbortSignal,
  ): Promise<void> | void;
};

type DeviceSessionStateOptions = {
  serial: string;
  applyLocation(
    serial: string,
    fix: GeoFix,
    signal: AbortSignal,
  ): Promise<void>;
  recorder?: SessionRecorder;
  logcat?: LogcatHub;
  routeClock?: RoutePlaybackClock;
  now?: () => number;
};

function abortReason(signal: AbortSignal, fallback: string): Error {
  return signal.reason instanceof Error
    ? signal.reason
    : new DOMException(fallback, "AbortError");
}

/**
 * State whose lifetime belongs to an Android device, not to one video source.
 *
 * A scrcpy/grpc-screenshot transition briefly has two owners while the new
 * source is staged. Publishing the candidate moves the replay input target;
 * releasing the old source therefore cannot close recording, route, location,
 * or logcat state. The resources close only after the final owner releases.
 */
export class DeviceSessionState {
  readonly serial: string;
  readonly recorder: SessionRecorder;
  readonly logcat: LogcatHub;
  readonly route: RoutePlayback;
  readonly abortController = new AbortController();
  readonly replayHandlers: ReplayHandlers;

  lastLocation: (GeoFix & { appliedAt: string }) | null = null;

  readonly #applyLocation: DeviceSessionStateOptions["applyLocation"];
  readonly #now: () => number;
  readonly #owners = new Set<DeviceStateOwner>();
  readonly #inputTargets = new Map<DeviceStateOwner, ReplayInputTarget>();
  #activeInputOwner: DeviceStateOwner | null = null;
  #disposeTask: Promise<void> | null = null;

  constructor(options: DeviceSessionStateOptions) {
    this.serial = options.serial;
    this.#applyLocation = options.applyLocation;
    this.#now = options.now ?? Date.now;
    this.recorder = options.recorder ?? new SessionRecorder();
    this.logcat = options.logcat ?? new LogcatHub(options.serial);
    this.route = new RoutePlayback({
      applyLocation: async (fix, signal) => {
        await this.#setLocation(fix, signal, false);
      },
      onLocation: (fix) => {
        if (!this.signal.aborted) this.lastLocation = fix;
      },
      clock: options.routeClock,
    });
    this.replayHandlers = {
      dispatchGesture: async (gesture, signal) => {
        if (signal.aborted) {
          throw abortReason(signal, "session replay cancelled");
        }
        const target = this.#activeInputOwner
          ? this.#inputTargets.get(this.#activeInputOwner)
          : undefined;
        if (!target) {
          throw new SessionReplayConflictError(
            "device stream changed during session replay",
          );
        }
        await target.dispatchGesture(gesture, signal);
      },
      setLocation: async (fix, signal) => {
        this.route.stop();
        await this.#setLocation(fix, signal, true);
      },
    };
  }

  get signal(): AbortSignal {
    return this.abortController.signal;
  }

  get disposed(): boolean {
    return this.#disposeTask !== null;
  }

  get hasActiveInput(): boolean {
    return this.#activeInputOwner !== null;
  }

  acquire(owner: DeviceStateOwner): void {
    if (this.#disposeTask || this.signal.aborted) {
      throw new SessionReplayConflictError("device session state is closed");
    }
    this.#owners.add(owner);
  }

  activate(owner: DeviceStateOwner, target: ReplayInputTarget): void {
    if (!this.#owners.has(owner) || this.#disposeTask) {
      throw new SessionReplayConflictError(
        "cannot activate an unowned device session state",
      );
    }
    this.#inputTargets.set(owner, target);
    this.#activeInputOwner = owner;
  }

  async applyLocation(
    fix: GeoFix,
    signal: AbortSignal = this.signal,
  ): Promise<GeoFix & { appliedAt: string }> {
    return this.#setLocation(fix, signal, true);
  }

  release(owner: DeviceStateOwner, reason: string): Promise<void> {
    if (!this.#owners.delete(owner)) {
      return this.#disposeTask ?? Promise.resolve();
    }
    this.#inputTargets.delete(owner);
    if (this.#activeInputOwner === owner) {
      this.#activeInputOwner =
        Array.from(this.#inputTargets.keys()).at(-1) ?? null;
    }
    if (this.#owners.size > 0) return Promise.resolve();
    return this.#dispose(reason);
  }

  async #setLocation(
    fix: GeoFix,
    signal: AbortSignal,
    updateSnapshot: boolean,
  ): Promise<GeoFix & { appliedAt: string }> {
    if (this.signal.aborted) {
      throw abortReason(this.signal, "device session state is closed");
    }
    if (signal.aborted) throw abortReason(signal, "location update aborted");
    const combined =
      signal === this.signal
        ? signal
        : AbortSignal.any([signal, this.signal]);
    await this.#applyLocation(this.serial, fix, combined);
    if (combined.aborted) {
      throw abortReason(combined, "location update aborted");
    }
    const applied = {
      ...fix,
      appliedAt: new Date(this.#now()).toISOString(),
    };
    if (updateSnapshot) this.lastLocation = applied;
    return applied;
  }

  #dispose(reason: string): Promise<void> {
    if (this.#disposeTask) return this.#disposeTask;
    this.abortController.abort(new Error(reason));
    this.#activeInputOwner = null;
    this.#inputTargets.clear();
    this.route.stop();
    this.route.close();
    this.logcat.close(reason);
    this.#disposeTask = (async () => {
      await this.recorder.dispose();
      // A start awaiting its first fix may otherwise install a timer after the
      // initial close. Closing twice is deliberately idempotent.
      this.route.stop();
      this.route.close();
    })();
    return this.#disposeTask;
  }
}

export type { DeviceSessionStateOptions, ReplayInputTarget };
