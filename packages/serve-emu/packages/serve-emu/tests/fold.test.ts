import { describe, expect, test } from "bun:test";
import { getFoldStatus, readAvailableFoldStatus, setFoldPosture } from "../src/fold.ts";
import type { EmulatorGrpcClient, GrpcEndpoint } from "../src/emulator-grpc.ts";

type FoldClient = Pick<EmulatorGrpcClient, "getPhysicalModel" | "setPosture" | "close">;

function fakeClient(options: { supported?: boolean; posture?: number } = {}) {
  let posture = options.posture ?? 1;
  const commands: number[] = [];
  let closed = false;
  const client: FoldClient = {
    getPhysicalModel: async (target) =>
      options.supported === false
        ? { status: -2, value: null }
        : { status: 0, value: target === 16 ? posture : posture === 1 ? 0 : 180 },
    setPosture: async (value) => {
      commands.push(value);
      posture = value;
    },
    close: () => { closed = true; },
  };
  return { client, commands, get closed() { return closed; } };
}

describe("Android emulator fold controls", () => {
  test("does not repeat a failed gRPC read on every status poll", async () => {
    let attempts = 0;
    const create = async (): Promise<FoldClient> => {
      attempts++;
      throw new Error("gRPC timed out");
    };
    await expect(getFoldStatus("emulator-5556", create)).rejects.toThrow("gRPC timed out");
    await expect(getFoldStatus("emulator-5556", create)).rejects.toThrow("temporarily unavailable");
    expect(attempts).toBe(1);
    const recovered = fakeClient({ posture: 3 });
    await setFoldPosture("emulator-5556", "opened", async () => recovered.client);
    expect(await getFoldStatus("emulator-5556", async () => recovered.client)).toEqual({
      supported: true,
      posture: "opened",
      hingeAngle: 180,
    });
  });

  test("retries a read with remembered credentials when discovery credentials fail", async () => {
    const endpoints: GrpcEndpoint[] = [
      { port: 8554, token: "stale", avdName: null },
      { port: 8554, token: "current", avdName: null },
    ];
    const attempts: string[] = [];
    const closed: string[] = [];
    const connect = (endpoint: GrpcEndpoint): FoldClient => ({
      getPhysicalModel: async (target) => {
        attempts.push(endpoint.token!);
        if (endpoint.token === "stale") throw new Error("unauthenticated");
        return { status: 0, value: target === 16 ? 3 : 180 };
      },
      setPosture: async () => {},
      close: () => { closed.push(endpoint.token!); },
    });
    expect(await readAvailableFoldStatus("emulator-5554", endpoints, connect)).toEqual({
      supported: true,
      posture: "opened",
      hingeAngle: 180,
    });
    expect(attempts).toEqual(["stale", "stale", "current", "current"]);
    expect(closed).toEqual(["stale", "current"]);
  });

  test("reports posture and hinge angle, then confirms unfold without replacing the stream", async () => {
    const fake = fakeClient();
    const create = async () => fake.client;
    expect(await getFoldStatus("emulator-5554", create)).toEqual({
      supported: true,
      posture: "closed",
      hingeAngle: 0,
    });
    expect(await setFoldPosture("emulator-5554", "opened", create)).toEqual({
      supported: true,
      posture: "opened",
      hingeAngle: 180,
    });
    expect(fake.commands).toEqual([3]);
    expect(fake.closed).toBe(true);
  });

  test("does not send fold commands to unsupported devices", async () => {
    const fake = fakeClient({ supported: false });
    await expect(setFoldPosture("emulator-5554", "closed", async () => fake.client))
      .rejects.toThrow("does not support folding");
    expect(fake.commands).toEqual([]);
    expect(fake.closed).toBe(true);
    expect(await getFoldStatus("physical-1", async () => {
      throw new Error("must not open gRPC");
    })).toEqual({ supported: false, posture: null, hingeAngle: null });
  });
});
