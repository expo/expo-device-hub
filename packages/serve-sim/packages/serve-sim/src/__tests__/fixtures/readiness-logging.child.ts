import { expect, mock, test } from "bun:test";
import * as sessions from "../../device-session";
import { clearServeSimState, inProcessServeSimState, writeServeSimState } from "../../state";
import { useTempStateDir, UDID } from "../helpers";

function createSession(fail: boolean) {
  let started: Promise<void> | undefined;
  return {
    start: () =>
      (started ??= fail
        ? Promise.reject(new Error("capture initialization failed"))
        : Promise.resolve()),
  };
}
let session = createSession(true);
mock.module("../../device-session", () => ({
  ...sessions,
  getDeviceSession: () => session,
}));
const { simMiddleware } = await import("../../middleware");

test("readiness logs missing state, capture failure and replacement-session recovery once per transition", async () => {
  const state = useTempStateDir();
  const middleware = simMiddleware({ basePath: "/", device: UDID });
  const request = () => middleware(new Request("http://127.0.0.1:3200/readyz"));
  try {
    for (let i = 0; i < 2; i++) expect((await request())?.status).toBe(503);
    writeServeSimState(inProcessServeSimState(UDID, 3200));
    for (let i = 0; i < 2; i++) expect((await request())?.status).toBe(503);
    // A rejected start stays cached. Recovery requires a replacement session.
    expect((await request())?.status).toBe(503);
    session = createSession(false);
    for (let i = 0; i < 2; i++) {
      const response = await request();
      expect(response?.status).toBe(200);
      expect(await response?.json()).toEqual({ status: "ready", device: UDID });
    }
  } finally {
    state.restore();
  }
});

test("unqualified readiness logs a second outage after recovery", async () => {
  const state = useTempStateDir();
  session = createSession(false);
  const middleware = simMiddleware({ basePath: "/" });
  const request = () => middleware(new Request("http://127.0.0.1:3200/readyz"));
  try {
    for (let i = 0; i < 2; i++) expect((await request())?.status).toBe(503);
    writeServeSimState(inProcessServeSimState(UDID, 3200));
    for (let i = 0; i < 2; i++) expect((await request())?.status).toBe(200);
    clearServeSimState(UDID, process.pid);
    for (let i = 0; i < 2; i++) expect((await request())?.status).toBe(503);
  } finally {
    state.restore();
  }
});
