import { expect, test } from "bun:test";
import { act, create, type ReactTestRenderer } from "react-test-renderer";
import type { DeviceClient } from "../types";
import { usePhysicalIosDeviceClient } from "../usePhysicalIosDevice";
import { createGlobalStubs } from "./test-globals";

test("physical iOS never sends an orphan release after an ignored down or video recovery", async () => {
  const { stubGlobal, restoreGlobals } = createGlobalStubs();
  let renderer: ReactTestRenderer | undefined;
  let client!: DeviceClient;
  let deliver!: (value: Response) => void;
  const inputs: { generation: number; samples: { phase: number }[] }[] = [];
  let closes = 0;
  stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  stubGlobal(
    "VideoDecoder",
    class {
      static async isConfigSupported() {
        return { supported: true };
      }
      state = "unconfigured";
      decodeQueueSize = 0;
      configure() {
        this.state = "configured";
      }
      reset() {
        this.state = "unconfigured";
      }
      decode() {}
      close() {
        this.state = "closed";
      }
    },
  );
  stubGlobal("EncodedVideoChunk", class {});
  stubGlobal("fetch", async (url: string, options: RequestInit) => {
    if (url.endsWith("/open")) return Response.json({ session: "test" });
    if (url.endsWith("/read"))
      return new Promise<Response>((resolve, reject) => {
        deliver = resolve;
        options.signal?.addEventListener("abort", () => reject(new Error("aborted")), {
          once: true,
        });
      });
    if (url.endsWith("/input")) inputs.push(JSON.parse(String(options.body)));
    if (url.endsWith("/close")) closes++;
    return Response.json({ ok: true });
  });
  function Harness() {
    client = usePhysicalIosDeviceClient({
      enabled: true,
      baseUrl: "http://localhost/api/ios-device",
      device: "test",
      streamMode: "mjpeg",
    });
    return null;
  }
  const frame = { key: true, timestamp: 0, data: "AQ==" };
  const batch = async (generation: number, frames: (typeof frame)[]) => {
    await act(async () =>
      deliver(
        Response.json({
          generation,
          frames,
          configuration: { width: 100, height: 200, codec: "hvc1", description: "AQ==" },
        }),
      ),
    );
  };
  const touch = async (phase: "begin" | "end") => {
    await act(async () => client.sendTouch({ phase, x: 0.5, y: 0.5 }));
  };
  try {
    await act(async () => {
      renderer = create(<Harness />);
    });
    await batch(0, []);
    await touch("begin");
    await batch(0, [frame]);
    await touch("end");
    expect(inputs).toHaveLength(0);
    await touch("begin");
    await touch("end");
    expect(inputs.flatMap((input) => input.samples.map((sample) => sample.phase))).toEqual([0, 2]);
    await touch("begin");
    await batch(1, [frame]);
    await touch("end");
    expect(inputs).toHaveLength(3);
    await touch("begin");
    await touch("end");
    expect(inputs.slice(3).map((input) => input.generation)).toEqual([1, 1]);
  } finally {
    if (renderer) await act(async () => renderer?.unmount());
    restoreGlobals();
  }
  expect(closes).toBeGreaterThan(0);
});
