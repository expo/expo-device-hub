import type { Gesture } from "./input.ts";
import type { GeoFix } from "./location.ts";

export type RecordedEvent =
  | {
      id: number;
      at: string;
      delayMs: number;
      source: string;
      kind: "gesture";
      gesture: Gesture;
    }
  | {
      id: number;
      at: string;
      delayMs: number;
      source: string;
      kind: "location";
      location: GeoFix;
    };

export type SessionSnapshot = {
  events: RecordedEvent[];
  recording: boolean;
  replaying: boolean;
  replayStartedAt: string | null;
  replayCompletedAt: string | null;
  lastError: string | null;
};

type ReplayHandlers = {
  dispatchGesture: (gesture: Gesture) => Promise<void>;
  setLocation: (fix: GeoFix) => Promise<void> | void;
};

const MAX_EVENTS = 2_000;

function sleep(ms: number) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export class SessionRecorder {
  #events: RecordedEvent[] = [];
  #nextId = 1;
  #lastEventMs = 0;
  #recording = true;
  #replaying = false;
  #stopReplay = false;
  #replayStartedAt: string | null = null;
  #replayCompletedAt: string | null = null;
  #lastError: string | null = null;

  get isReplaying(): boolean {
    return this.#replaying;
  }

  recordGesture(gesture: Gesture, source: string): void {
    this.#record({ kind: "gesture", gesture, source });
  }

  recordLocation(location: GeoFix, source: string): void {
    this.#record({ kind: "location", location, source });
  }

  clear(): SessionSnapshot {
    this.#events = [];
    this.#lastEventMs = 0;
    this.#lastError = null;
    this.#replayCompletedAt = null;
    return this.snapshot();
  }

  stopReplay(): SessionSnapshot {
    this.#stopReplay = true;
    return this.snapshot();
  }

  snapshot(): SessionSnapshot {
    return {
      events: this.#events,
      recording: this.#recording,
      replaying: this.#replaying,
      replayStartedAt: this.#replayStartedAt,
      replayCompletedAt: this.#replayCompletedAt,
      lastError: this.#lastError,
    };
  }

  async replay(handlers: ReplayHandlers, multiplier = 1): Promise<SessionSnapshot> {
    if (this.#replaying) throw new Error("session replay is already running");
    if (this.#events.length === 0) throw new Error("session has no recorded events");
    if (!Number.isFinite(multiplier) || multiplier <= 0 || multiplier > 100) {
      throw new Error("multiplier must be between 0 and 100");
    }

    const events = [...this.#events];
    this.#replaying = true;
    this.#stopReplay = false;
    this.#replayStartedAt = new Date().toISOString();
    this.#replayCompletedAt = null;
    this.#lastError = null;

    try {
      for (const event of events) {
        if (this.#stopReplay) break;
        await sleep(Math.max(0, event.delayMs / multiplier));
        if (event.kind === "gesture") {
          await handlers.dispatchGesture(event.gesture);
        } else {
          await handlers.setLocation(event.location);
        }
      }
      this.#replayCompletedAt = new Date().toISOString();
    } catch (err) {
      this.#lastError = err instanceof Error ? err.message : String(err);
      throw err;
    } finally {
      this.#replaying = false;
      this.#stopReplay = false;
    }

    return this.snapshot();
  }

  #record(
    event:
      | { kind: "gesture"; gesture: Gesture; source: string }
      | { kind: "location"; location: GeoFix; source: string },
  ): void {
    if (!this.#recording || this.#replaying) return;
    const now = Date.now();
    const delayMs = this.#lastEventMs ? Math.max(0, now - this.#lastEventMs) : 0;
    this.#lastEventMs = now;
    const base = {
      id: this.#nextId++,
      at: new Date(now).toISOString(),
      delayMs,
      source: event.source,
    };
    this.#events.push(
      event.kind === "gesture"
        ? { ...base, kind: "gesture", gesture: event.gesture }
        : { ...base, kind: "location", location: event.location },
    );
    if (this.#events.length > MAX_EVENTS) {
      this.#events.splice(0, this.#events.length - MAX_EVENTS);
    }
  }
}
