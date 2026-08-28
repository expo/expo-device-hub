import { describe, expect, test } from "bun:test";
import { SessionRecorder } from "./session-recorder.ts";

describe("session replay cancellation", () => {
  test("does not dispatch an event after cancellation during its delay", async () => {
    const recorder = new SessionRecorder();
    recorder.recordLocation({ latitude: 1, longitude: 1 }, "test");
    await Bun.sleep(150);
    recorder.recordLocation({ latitude: 2, longitude: 2 }, "test");

    const applied: number[] = [];
    let firstApplied!: () => void;
    const sawFirst = new Promise<void>((resolve) => {
      firstApplied = resolve;
    });
    const replay = recorder.replay({
      dispatchGesture: async () => {},
      setLocation: (fix) => {
        applied.push(fix.latitude);
        if (applied.length === 1) firstApplied();
      },
    });

    await sawFirst;
    await Bun.sleep(5);
    const stoppedAt = performance.now();
    recorder.stopReplay();
    await replay;
    expect(applied).toEqual([1]);
    expect(performance.now() - stoppedAt).toBeLessThan(75);
  });
});
