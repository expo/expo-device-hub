import { expect, test } from "bun:test";
import { DeviceSession } from "../../device-session";
import { createServer } from "http";

function recordingSession(device: string) {
  const session = new DeviceSession(device);
  const target = session as any;
  target.phase = "running";
  target.captureStart = Promise.resolve();
  return { session, target };
}

test("adoption awaits its server-owned writer and owned stop finalizes it", async () => {
  const { session, target } = recordingSession("adopt-recording-test");
  let release!: () => void;
  let starts = 0;
  let stops = 0;
  target.capture = {
    startRecording: async () => {
      starts++;
      await new Promise<void>((resolve) => {
        release = resolve;
      });
    },
    stopRecording: async () => {
      stops++;
      return "/tmp/job-video/session.json";
    },
    stop: async () => {},
  };
  const server = createServer((req, res) => {
    void session.handleVideoRecording(req, res);
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address() as { port: number };
  let done = false;
  try {
    const cancelled = await fetch(`http://127.0.0.1:${address.port}/recording/video`, {
      method: "DELETE",
      headers: { "x-recording-id": "cancelled-before-start" },
    });
    expect(cancelled.status).toBe(202);
    await expect(
      session.startAdoptedRecording("/tmp/job-video", "cancelled-before-start"),
    ).rejects.toThrow("cancelled");
    expect(starts).toBe(0);
    const starting = session.startAdoptedRecording("/tmp/job-video", "job-video").then(() => {
      done = true;
    });
    while (!starts) await Bun.sleep(1);
    expect(done).toBe(false);
    release();
    await starting;
    expect(target.recordingLease).toEqual({ id: "job-video" });
    const stop = () =>
      fetch(`http://127.0.0.1:${address.port}/recording/video`, {
        method: "DELETE",
        headers: { "x-recording-id": "job-video" },
      });
    expect(await (await stop()).json()).toEqual({ manifest: "/tmp/job-video/session.json" });
    expect(await (await stop()).json()).toEqual({ manifest: "/tmp/job-video/session.json" });
    expect(stops).toBe(1);
  } finally {
    release?.();
    server.close();
    session.close();
  }
});

test("cancelled adoption drains an in-flight writer before rejecting", async () => {
  const { session, target } = recordingSession("adopt-recording-cancel-test");
  let release!: () => void;
  let starts = 0;
  let stops = 0;
  target.capture = {
    startRecording: async () => {
      starts++;
      await new Promise<void>((resolve) => {
        release = resolve;
      });
    },
    stopRecording: async () => {
      stops++;
      return "/tmp/job-video/session.json";
    },
    stop: async () => {},
  };
  const abort = new AbortController();
  try {
    const starting = session.startAdoptedRecording("/tmp/job-video", "job-video", abort.signal);
    const result = starting.then(
      () => null,
      (error) => error,
    );
    while (!starts) await Bun.sleep(1);
    abort.abort();
    release();
    expect(await result).toBeInstanceOf(Error);
    expect(stops).toBe(1);
    expect(target.recordingLease).toBeUndefined();
    await expect(session.finishRecordingForShutdown()).resolves.toBeUndefined();
  } finally {
    release?.();
    session.close();
  }
});

test.each([
  {
    label: "no writer remains",
    cleanupError: new Error('Error Domain=serve-sim-recording Code=15 "No recording is active"'),
    aggregate: false,
  },
  {
    label: "cleanup fails again",
    cleanupError: new Error("cleanup retry failed"),
    aggregate: true,
  },
  { label: "cleanup succeeds", cleanupError: undefined, aggregate: false },
])(
  "cancelled writer finalization failure survives cleanup: $label",
  async ({ cleanupError, aggregate }) => {
    const { session, target } = recordingSession("adopt-recording-cancel-finalization-test");
    const finalizationError = new Error("cancelled writer finalization failed");
    let entered!: () => void,
      release!: () => void,
      draining!: () => void,
      finishCleanup!: () => void;
    const starting = new Promise<void>((resolve) => {
      entered = resolve;
    });
    const nativeStart = new Promise<void>((resolve) => {
      release = resolve;
    });
    const cleanupStarted = new Promise<void>((resolve) => {
      draining = resolve;
    });
    const cleanup = new Promise<void>((resolve) => {
      finishCleanup = resolve;
    });
    let stops = 0;
    target.capture = {
      startRecording: async () => {
        entered();
        await nativeStart;
      },
      stopRecording: async () => {
        if (++stops === 1) throw finalizationError;
        draining();
        await cleanup;
        if (cleanupError) throw cleanupError;
        return "/tmp/job-video/session.json";
      },
      stop: async () => {},
    };
    const abort = new AbortController();
    try {
      const result = session
        .startAdoptedRecording("/tmp/job-video", "job-video", abort.signal)
        .catch((error) => error);
      await starting;
      abort.abort();
      release();
      await cleanupStarted;
      let stopped = false;
      const shutdown = session
        .finishRecordingForShutdown()
        .catch((error) => error)
        .finally(() => {
          stopped = true;
        });
      await Bun.sleep(5);
      expect(stopped).toBe(false);
      finishCleanup();
      const error = await result;
      if (aggregate) {
        expect(error).toBeInstanceOf(AggregateError);
        expect(error.errors).toEqual([finalizationError, cleanupError]);
      } else expect(error).toBe(finalizationError);
      expect(await shutdown).toBe(error);
      expect(stops).toBe(2);
      expect(target.recordingLease).toBeUndefined();
      expect(target.cancelledRecordingStart).toBeUndefined();
      await expect(session.finishRecordingForShutdown()).rejects.toBe(finalizationError);
    } finally {
      release();
      finishCleanup();
      session.close();
    }
  },
);

test("a partially failed adopted writer is drained and its failure remains visible", async () => {
  const { session, target } = recordingSession("adopt-recording-failure-test");
  let stops = 0;
  target.capture = {
    startRecording: async () => {
      throw new Error("writer could not start");
    },
    stopRecording: async () => {
      stops++;
      return "/tmp/failed/session.json";
    },
    stop: async () => {},
  };
  try {
    await expect(session.startAdoptedRecording("/tmp/failed", "failed")).rejects.toThrow(
      "writer could not start",
    );
    expect(stops).toBe(1);
    expect(target.recordingLease).toBeUndefined();
  } finally {
    session.close();
  }
});

test("a native start that never created a writer does not fail shutdown", async () => {
  const { session, target } = recordingSession("adopt-recording-no-writer-test");
  let stops = 0;
  // Native startRecording throws before it assigns a recorder; stopRecording then has nothing to stop.
  target.capture = {
    startRecording: async () => {
      throw new Error(
        "The native simulator display is unavailable; check that the device is booted and retry",
      );
    },
    stopRecording: async () => {
      stops++;
      // The message the native addon actually gives JS for this NSError.
      throw new Error(
        'Error Domain=serve-sim-recording Code=15 "No recording is active; start recording before stopping it" UserInfo={NSLocalizedDescription=No recording is active; start recording before stopping it}',
      );
    },
    stop: async () => {},
  };
  try {
    await expect(session.startAdoptedRecording("/tmp/no-writer", "no-writer")).rejects.toThrow(
      /^The native simulator display is unavailable/,
    );
    expect(stops).toBe(1);
    await expect(session.finishRecordingForShutdown()).resolves.toBeUndefined();
  } finally {
    session.close();
  }
});

test("an existing recorder is never replaced by adoption", async () => {
  const { session, target } = recordingSession("adopt-recording-conflict-test");
  target.refreshRecordingLease("existing");
  let stops = 0;
  target.capture = {
    stop: async () => {},
    stopRecording: async () => {
      stops++;
    },
  };
  try {
    await expect(session.startAdoptedRecording("/tmp/job", "job")).rejects.toThrow(
      "already active",
    );
    expect(target.recordingLease.id).toBe("existing");
    expect(stops).toBe(0);
  } finally {
    session.close();
  }
});

test("shutdown waits for failed-start writer cleanup", async () => {
  const { session, target } = recordingSession("adopt-recording-drain-test");
  let draining = false;
  let release!: () => void;
  target.capture = {
    startRecording: async () => {
      throw new Error("partial startup failed");
    },
    stopRecording: async () => {
      draining = true;
      await new Promise<void>((resolve) => {
        release = resolve;
      });
      return "/tmp/partial/session.json";
    },
    stop: async () => {},
  };
  try {
    const starting = session
      .startAdoptedRecording("/tmp/partial", "partial")
      .catch((error) => error);
    for (let i = 0; i < 100 && !draining; i++) await Bun.sleep(1);
    expect(draining).toBe(true);
    let stopped = false;
    const shutdown = session
      .finishRecordingForShutdown()
      .catch((error) => error)
      .finally(() => {
        stopped = true;
      });
    await Bun.sleep(5);
    expect(stopped).toBe(false);
    release();
    expect(await starting).toBeInstanceOf(Error);
    await shutdown;
    expect(stopped).toBe(true);
  } finally {
    release?.();
    session.close();
  }
});

test("failed partial-start cleanup remains a shutdown failure", async () => {
  const { session, target } = recordingSession("adopt-recording-cleanup-failure-test");
  target.capture = {
    startRecording: async () => {
      throw new Error("startup failed");
    },
    stopRecording: async () => {
      throw new Error("cleanup failed");
    },
    stop: async () => {},
  };
  try {
    await expect(session.startAdoptedRecording("/tmp/failed", "failed")).rejects.toThrow(
      "Recording startup and cleanup failed",
    );
    await expect(session.finishRecordingForShutdown()).rejects.toThrow("cleanup failed");
  } finally {
    session.close();
  }
});
