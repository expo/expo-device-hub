export interface AvccFallbackState {
  streamed: boolean;
  fellBack: boolean;
}

export type AvccFallbackEvent = 'decoded-frame' | 'timeout' | 'error' | 'reset';

export const initialAvccFallback: AvccFallbackState = {
  streamed: false,
  fellBack: false,
};

/** Matches serve-sim's one-way H.264-to-MJPEG recovery policy. */
export function avccFallbackReducer(
  state: AvccFallbackState,
  event: AvccFallbackEvent,
): AvccFallbackState {
  switch (event) {
    case 'decoded-frame':
      return state.streamed ? state : { ...state, streamed: true };
    case 'timeout':
      return state.streamed || state.fellBack ? state : { ...state, fellBack: true };
    case 'error':
      return state.fellBack ? state : { ...state, fellBack: true };
    case 'reset':
      return initialAvccFallback;
  }
}

export const AVCC_FRAME_TIMEOUT_MS = 4_000;
