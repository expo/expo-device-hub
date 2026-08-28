import { describe, expect, test } from "bun:test";
import { parseEmulatorGrpcPort } from "./emulator-grpc.ts";

describe("emulator gRPC console output", () => {
  test("parses an already-active endpoint response", () => {
    expect(parseEmulatorGrpcPort('OK: { "port": "8554" }')).toBe(8554);
  });

  test("parses the endpoint-started response", () => {
    expect(parseEmulatorGrpcPort("OK: gRPC endpoint available at port 43127")).toBe(43127);
  });

  test("rejects missing or invalid ports", () => {
    expect(parseEmulatorGrpcPort("OK")).toBeNull();
    expect(parseEmulatorGrpcPort("port 70000")).toBeNull();
  });
});
