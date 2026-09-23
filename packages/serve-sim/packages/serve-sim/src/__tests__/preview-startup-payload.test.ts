import { describe, expect, test } from "bun:test";

import { inProcessServeSimState, previewStartupPayload } from "../state";

const stateFor = (udid: string, port: number) => inProcessServeSimState(udid, port, "/", "0.0.0.0");

describe("previewStartupPayload", () => {
  test("carries the token for a single device when the gate is on", () => {
    const payload = previewStartupPayload([stateFor("A", 3200)], "tok-123");

    expect(payload.token).toBe("tok-123");
    expect(payload.port).toBe(3200);
    expect(payload.device).toBe("A");
    expect(typeof payload.url).toBe("string");
  });

  test("omits the token entirely when the gate is off", () => {
    const payload = previewStartupPayload([stateFor("A", 3200)]);

    expect("token" in payload).toBe(false);
  });

  test("carries the token alongside the device list for multiple devices", () => {
    const payload = previewStartupPayload([stateFor("A", 3200), stateFor("B", 3201)], "tok-123");

    expect(payload.token).toBe("tok-123");
    expect(Array.isArray(payload.devices)).toBe(true);
    expect((payload.devices as unknown[]).length).toBe(2);
  });

  test("survives a JSON round-trip, since it is printed to stdout", () => {
    const payload = previewStartupPayload([stateFor("A", 3200)], "tok-123");
    const parsed = JSON.parse(JSON.stringify(payload));

    expect(parsed.token).toBe("tok-123");
  });
});
