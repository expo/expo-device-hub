import { describe, expect, test } from 'bun:test';

import { androidWebRtcRestartKey } from '../android-stream-source';
import { observeWebRtcRestartKey } from '../webrtc-restart';

describe('capture generation WebRTC restart', () => {
  test('uses initial metadata as a baseline without restarting a connecting peer', () => {
    const unknown = { key: null, generation: 0 };
    expect(androidWebRtcRestartKey(null, null)).toBeNull();
    const baseline = observeWebRtcRestartKey(
      unknown,
      androidWebRtcRestartKey({ sessionGeneration: 1 }, null),
    );
    expect(baseline).toEqual({ key: 1, generation: 0 });
    expect(observeWebRtcRestartKey(baseline, 1)).toBe(baseline);
  });

  test('restarts on successful replacement before a new frame commits the UI selection', () => {
    const displayed = { sessionGeneration: 1 };
    const pending = { sessionGeneration: 2 };

    const restarted = observeWebRtcRestartKey(
      { key: 1, generation: 0 },
      androidWebRtcRestartKey(displayed, pending),
    );
    expect(restarted).toEqual({ key: 2, generation: 1 });

    // Once video paints, committing pending state must not restart the new peer again.
    expect(observeWebRtcRestartKey(restarted, androidWebRtcRestartKey(pending, null))).toBe(
      restarted,
    );
  });

  test('preserves the restart generation when the source generation is unchanged', () => {
    const displayed = { sessionGeneration: 1 };
    const live = { key: 1, generation: 0 };
    expect(observeWebRtcRestartKey(live, androidWebRtcRestartKey(displayed, null))).toBe(live);
    expect(observeWebRtcRestartKey(live, androidWebRtcRestartKey(displayed, displayed))).toBe(live);
  });

  test('restarts on externally polled changes, including a server generation reset', () => {
    const live = { key: 2, generation: 1 };
    const external = observeWebRtcRestartKey(
      live,
      androidWebRtcRestartKey({ sessionGeneration: 3 }, null),
    );
    expect(external).toEqual({ key: 3, generation: 2 });
    expect(observeWebRtcRestartKey(external, 0)).toEqual({ key: 0, generation: 3 });
  });

  test('establishes a fresh baseline when device metadata becomes unknown', () => {
    const unknown = observeWebRtcRestartKey({ key: 2, generation: 1 }, null);
    expect(unknown).toEqual({ key: null, generation: 1 });
    expect(observeWebRtcRestartKey(unknown, 8)).toEqual({ key: 8, generation: 1 });
  });
});
