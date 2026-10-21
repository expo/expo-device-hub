import { expect, mock, test } from "bun:test";
import * as sessions from "../../device-session";
import { inProcessServeSimState, writeServeSimState } from "../../state";
import { useTempStateDir, UDID } from "../helpers";

let failure = true;
mock.module("../../device-session", () => ({
  ...sessions,
  getDeviceSession: () => ({
    start: async () => {
      if (failure) throw new Error("capture initialization failed");
    },
  }),
}));
const { simMiddleware } = await import("../../middleware");

test("readiness logs missing state, capture failure and recovery once per transition", async () => {
  const state = useTempStateDir();
  const middleware = simMiddleware({ basePath: "/", device: UDID });
  const request = () => middleware(new Request("http://127.0.0.1:3200/readyz"));
  try {
    for (let i = 0; i < 2; i++) expect((await request())?.status).toBe(503);
    writeServeSimState(inProcessServeSimState(UDID, 3200));
    for (let i = 0; i < 2; i++) expect((await request())?.status).toBe(503);
    failure = false;
    for (let i = 0; i < 2; i++) {
      const response = await request();
      expect(response?.status).toBe(200);
      expect(await response?.json()).toEqual({ status: "ready", device: UDID });
    }
  } finally {
    state.restore();
  }
});
