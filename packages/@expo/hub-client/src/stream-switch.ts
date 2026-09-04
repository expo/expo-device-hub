/**
 * Tracks an Android capture-source switch (`PUT /api/stream-mode`) from the
 * request until the replacement stream is actually on screen.
 *
 * serve-emu stages the new source, publishes it, and only then closes the
 * viewer sockets of the previous session and answers the request. The viewer
 * therefore sees two independent signals — the HTTP response and a stream
 * interruption followed by fresh frames — in either order. This reducer joins
 * them so the sidebar can keep reporting "switching" until the frame shows the
 * new source, instead of flipping the moment the response arrives.
 */

export type StreamSwitchPhase =
  /** No switch in progress. */
  | 'idle'
  /** The request is in flight. */
  | 'requesting'
  /** The server replaced the session, but the old stream has not dropped yet. */
  | 'awaiting-interruption'
  /** The old stream dropped; waiting for the first frame of the replacement. */
  | 'awaiting-frame';

export interface StreamSwitchState {
  phase: StreamSwitchPhase;
  /**
   * Whether the old stream is gone: it dropped since the current request
   * started, or it was not live when the request started.
   */
  interrupted: boolean;
  /** Whether the stream came (back) live while the request was in flight. */
  recovered: boolean;
}

export type StreamSwitchEvent =
  /**
   * `live` is whether the stream is on screen as the request starts. A switch
   * away from a stream that is not live (still connecting, or in error) has no
   * old session to wait for; its first frame is the replacement.
   */
  | { type: 'request-start'; live: boolean }
  | { type: 'request-failure' }
  /** `replaced` is whether the server started a new session generation. */
  | { type: 'request-success'; replaced: boolean }
  /** The live stream stopped delivering frames (or lost its control channel). */
  | { type: 'stream-interrupted' }
  /** The stream is live again. */
  | { type: 'stream-live' }
  /** The phase-specific safety timeout elapsed. */
  | { type: 'timeout' };

export const IDLE_STREAM_SWITCH: StreamSwitchState = {
  phase: 'idle',
  interrupted: false,
  recovered: false,
};

/** How long to wait for the old stream to drop after the server confirmed a replacement. */
export const STREAM_SWITCH_INTERRUPTION_TIMEOUT_MS = 3_000;
/** How long to wait for the replacement stream's first frame after the old one dropped. */
export const STREAM_SWITCH_FRAME_TIMEOUT_MS = 8_000;

const REQUESTING: StreamSwitchState = { phase: 'requesting', interrupted: false, recovered: false };
const REQUESTING_WITHOUT_STREAM: StreamSwitchState = {
  phase: 'requesting',
  interrupted: true,
  recovered: false,
};
const AWAITING_INTERRUPTION: StreamSwitchState = {
  phase: 'awaiting-interruption',
  interrupted: false,
  recovered: false,
};
const AWAITING_FRAME: StreamSwitchState = {
  phase: 'awaiting-frame',
  interrupted: true,
  recovered: false,
};

/** Pure transition; returns the same object when the event changes nothing. */
export function reduceStreamSwitch(
  state: StreamSwitchState,
  event: StreamSwitchEvent,
): StreamSwitchState {
  if (event.type === 'request-start') return event.live ? REQUESTING : REQUESTING_WITHOUT_STREAM;

  switch (state.phase) {
    case 'idle':
      return state;
    case 'requesting':
      switch (event.type) {
        case 'stream-interrupted':
          return state.interrupted && !state.recovered
            ? state
            : { ...state, interrupted: true, recovered: false };
        case 'stream-live':
          return state.interrupted && !state.recovered ? { ...state, recovered: true } : state;
        case 'request-failure':
          return IDLE_STREAM_SWITCH;
        case 'request-success':
          if (!event.replaced || state.recovered) return IDLE_STREAM_SWITCH;
          return state.interrupted ? AWAITING_FRAME : AWAITING_INTERRUPTION;
        case 'timeout':
          return state;
      }
      return state;
    case 'awaiting-interruption':
      if (event.type === 'stream-interrupted') return AWAITING_FRAME;
      if (event.type === 'timeout') return IDLE_STREAM_SWITCH;
      return state;
    case 'awaiting-frame':
      if (event.type === 'stream-live' || event.type === 'timeout') return IDLE_STREAM_SWITCH;
      return state;
  }
  return state;
}

/** Safety timeout for the phases that wait on the stream; null while nothing is awaited. */
export function streamSwitchTimeoutMs(phase: StreamSwitchPhase): number | null {
  if (phase === 'awaiting-interruption') return STREAM_SWITCH_INTERRUPTION_TIMEOUT_MS;
  if (phase === 'awaiting-frame') return STREAM_SWITCH_FRAME_TIMEOUT_MS;
  return null;
}

export function isStreamSwitchPending(state: StreamSwitchState): boolean {
  return state.phase !== 'idle';
}
