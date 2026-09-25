import { afterAll, beforeAll, expect, test } from "bun:test";

import { freePortAsync, installShims, UDID, useTempStateDir } from "../../__tests__/helpers";
import { simMiddleware } from "../../middleware";
import { servePreview, type PreviewServer } from "../../runtime";
import { captureRuntime } from "../runtime";

let port: number;
let server: PreviewServer;
let shims: ReturnType<typeof installShims>;
let stateDir: ReturnType<typeof useTempStateDir>;

beforeAll(async () => {
  shims = installShims({
    xcrun: `#!/bin/sh\nif [ "$2" = shutdown ]; then echo "Unable to shutdown device" >&2; exit 1; fi\necho '{"devices":{}}'\n`,
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
  }
});
