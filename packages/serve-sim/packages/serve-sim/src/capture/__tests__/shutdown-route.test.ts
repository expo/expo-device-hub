import { afterAll, beforeAll, expect, test } from "bun:test";

import { freePortAsync, installShims, UDID, useTempStateDir } from "../../__tests__/helpers";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { simMiddleware, retryPendingCaptureCleanup } from "../../middleware";
import { servePreview, type PreviewServer } from "../../runtime";
import { captureRuntime } from "../runtime";

let port: number;
let server: PreviewServer;
let shims: ReturnType<typeof installShims>;
let stateDir: ReturnType<typeof useTempStateDir>;

beforeAll(async () => {
  shims = installShims({
    xcrun: readFileSync(
      join(import.meta.dir, "../../__tests__/fixtures/grid-shutdown-xcrun.cjs"),
      "utf8",
    ),
  });
  stateDir = useTempStateDir();
  port = await freePortAsync();
  server = await servePreview({
    port,
    host: "127.0.0.1",
    middleware: simMiddleware({ basePath: "/" }),
  });
});

afterAll(() => {
  server?.stop(true);
  stateDir?.restore();
  shims?.restore();
});

test("keeps capture running when the device fails to shut down", async () => {
  const previous = process.env.SERVE_SIM_GRID_SHUTDOWN_FAIL;
  process.env.SERVE_SIM_GRID_SHUTDOWN_FAIL = "1";
  const disabled: string[] = [];
  const disableForDevice = captureRuntime.disableForDevice;
  captureRuntime.disableForDevice = async (udid) => void disabled.push(udid);
  try {
    const response = await fetch(`http://127.0.0.1:${port}/grid/api/shutdown`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ udid: UDID }),
    });
    expect(response.status).toBe(500);
    expect(disabled).toEqual([]);
  } finally {
    captureRuntime.disableForDevice = disableForDevice;
    if (previous === undefined) delete process.env.SERVE_SIM_GRID_SHUTDOWN_FAIL;
    else process.env.SERVE_SIM_GRID_SHUTDOWN_FAIL = previous;
  }
});

test("successful grid shutdown retains capture cleanup retry", async () => {
  const originalDisable = captureRuntime.disableForDevice;
  const originalStore = captureRuntime.storeFor;
  const session = {} as NonNullable<ReturnType<typeof captureRuntime.storeFor>>;
  let attempts = 0;
  captureRuntime.storeFor = () => session;
  captureRuntime.disableForDevice = async () => {
    attempts++;
    if (attempts === 1) throw new Error("temporary capture cleanup failure");
  };
  try {
    const response = await fetch(`http://127.0.0.1:${port}/grid/api/shutdown`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ udid: UDID }),
    });
    expect(response.status).toBe(200);
    expect(attempts).toBe(1);
    await retryPendingCaptureCleanup();
    expect(attempts).toBe(2);
  } finally {
    await retryPendingCaptureCleanup({ session: () => null });
    captureRuntime.disableForDevice = originalDisable;
    captureRuntime.storeFor = originalStore;
  }
});
