import { expect, test } from "bun:test";
import { access, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
import { execText } from "../src/exec.ts";

const CHILD_START_TIMEOUT_MS = 5_000;
const BOUNDED_COMPLETION_MS = 2_500;

function hangingChildScript(readyPath: string): string {
  return [
    'import { writeFileSync } from "node:fs";',
    `writeFileSync(${JSON.stringify(readyPath)}, "ready");`,
    "setInterval(() => {}, 1_000);",
  ].join("\n");
}

async function pathExists(path: string): Promise<boolean> {
  try {
    await access(path);
    return true;
  } catch {
    return false;
  }
}

async function waitForPath(path: string): Promise<void> {
  const deadline = Date.now() + CHILD_START_TIMEOUT_MS;
  while (Date.now() < deadline) {
    if (await pathExists(path)) return;
    await sleep(20);
  }
  throw new Error(`child did not report ready within ${CHILD_START_TIMEOUT_MS}ms`);
}

function within<T>(promise: Promise<T>, timeoutMs: number): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(
      () => reject(new Error(`operation exceeded ${timeoutMs}ms`)),
      timeoutMs,
    );
    promise.then(
      (value) => {
        clearTimeout(timer);
        resolve(value);
      },
      (error) => {
        clearTimeout(timer);
        reject(error);
      },
    );
  });
}

async function expectExecutorStillWorks(): Promise<void> {
  const result = await within(
    execText(process.execPath, ["-e", 'process.stdout.write("ok")'], {
      timeout: 2_000,
    }),
    BOUNDED_COMPLETION_MS,
  );
  expect(result.status).toBe(0);
  expect(result.timedOut).toBe(false);
  expect(result.stdout).toBe("ok");
}

test("execText aborts a running child and releases its executor slot", async () => {
  const dir = await mkdtemp(join(tmpdir(), "serve-emu-exec-abort-"));
  const readyPath = join(dir, "ready");
  const controller = new AbortController();
  const running = execText(
    process.execPath,
    ["-e", hangingChildScript(readyPath)],
    { signal: controller.signal, timeout: 10_000 },
  );
  void running.catch(() => {});

  try {
    await waitForPath(readyPath);
    const abortedAt = Date.now();
    controller.abort(new Error("cancel running command"));

    const aborted = await within(running, BOUNDED_COMPLETION_MS);
    expect(aborted.error?.message).toBe("command was aborted");
    expect(aborted.error?.cause).toBe(controller.signal.reason);
    expect(Date.now() - abortedAt).toBeLessThan(BOUNDED_COMPLETION_MS);

    await expectExecutorStillWorks();
  } finally {
    controller.abort(new Error("test cleanup"));
    await Promise.allSettled([running]);
    await rm(dir, { recursive: true, force: true });
  }
});

test("execText enforces a deadline and leaves the executor usable", async () => {
  const startedAt = Date.now();
  const result = await within(
    execText(
      process.execPath,
      ["-e", "setInterval(() => {}, 1_000)"],
      { timeout: 250 },
    ),
    BOUNDED_COMPLETION_MS,
  );

  expect(Date.now() - startedAt).toBeLessThan(BOUNDED_COMPLETION_MS);
  expect(result.timedOut).toBe(true);
  expect(result.status).toBeNull();
  expect(result.signal).toBe("SIGKILL");

  await expectExecutorStillWorks();
});

test("execText reaps a child that exceeds maxBuffer before releasing its slot", async () => {
  const result = await within(
    execText(
      process.execPath,
      [
        "-e",
        'process.stdout.write("x".repeat(64 * 1024)); setInterval(() => {}, 1_000)',
      ],
      { maxBuffer: 1_024, timeout: 10_000 },
    ),
    BOUNDED_COMPLETION_MS,
  );

  expect(result.error?.message).toBe(
    "combined stdout and stderr exceed 1024 bytes",
  );
  expect(result.signal).toBe("SIGKILL");
  await expectExecutorStillWorks();
});

test("aborting a command queued at the concurrency gate does not consume a slot", async () => {
  const dir = await mkdtemp(join(tmpdir(), "serve-emu-exec-queue-"));
  const holderControllers = Array.from(
    { length: 4 },
    () => new AbortController(),
  );
  const holderPaths = holderControllers.map((_, index) =>
    join(dir, `holder-${index}`),
  );
  const holders = holderControllers.map((controller, index) =>
    execText(
      process.execPath,
      ["-e", hangingChildScript(holderPaths[index])],
      { signal: controller.signal, timeout: 10_000 },
    ),
  );
  for (const holder of holders) void holder.catch(() => {});

  const queuedPath = join(dir, "queued-command-started");
  const queuedController = new AbortController();
  let probeController: AbortController | null = null;

  try {
    await Promise.all(holderPaths.map(waitForPath));

    const queued = execText(
      process.execPath,
      ["-e", hangingChildScript(queuedPath)],
      { signal: queuedController.signal, timeout: 10_000 },
    );
    void queued.catch(() => {});
    queuedController.abort(new Error("cancel queued command"));

    const aborted = await within(queued, BOUNDED_COMPLETION_MS);
    expect(aborted.error?.message).toBe("command was aborted");
    expect(aborted.error?.cause).toBe(queuedController.signal.reason);
    expect(await pathExists(queuedPath)).toBe(false);

    // Free exactly one of the four occupied slots. If the cancelled waiter was
    // left in the queue, it absorbs this release and the probe cannot start.
    holderControllers[0].abort(new Error("free one executor slot"));
    const released = await within(holders[0], BOUNDED_COMPLETION_MS);
    expect(released.error?.cause).toBe(holderControllers[0].signal.reason);

    probeController = new AbortController();
    const probeTimeout = setTimeout(
      () => probeController?.abort(new Error("probe could not acquire slot")),
      BOUNDED_COMPLETION_MS - 250,
    );
    try {
      const probe = await within(
        execText(process.execPath, ["-e", 'process.stdout.write("probe")'], {
          signal: probeController.signal,
          timeout: 2_000,
        }),
        BOUNDED_COMPLETION_MS,
      );
      expect(probe.status).toBe(0);
      expect(probe.stdout).toBe("probe");
    } finally {
      clearTimeout(probeTimeout);
    }

    expect(await pathExists(queuedPath)).toBe(false);
  } finally {
    queuedController.abort(new Error("test cleanup"));
    probeController?.abort(new Error("test cleanup"));
    for (const controller of holderControllers) {
      controller.abort(new Error("test cleanup"));
    }
    await Promise.allSettled(holders);
    await rm(dir, { recursive: true, force: true });
  }

  await expectExecutorStillWorks();
});
