import { describe, expect, test } from "bun:test";
import type { Device } from "../src/adb.ts";
import { MicAudioError } from "../src/mic-audio.ts";
import { MicInjector, MicInjectors } from "../src/mic-injector.ts";
import { createRouter, type EmuApp } from "../src/middleware.ts";
import { handleMicrophoneRequest } from "../src/microphone.ts";
import { parseMicrophoneStatusResponse } from "../src/shared/api-contracts.ts";

const SERIAL = "emulator-5554";
// One second of silence at 44.1 kHz mono 16-bit.
const PCM = Buffer.alloc(88_200);

/** Injectors that never see a recording, so they never open a call. */
function quietInjectors(): MicInjectors {
  return new MicInjectors(
    (serial) =>
      new MicInjector(serial, {
        isRecording: async () => false,
        openStream: async () => {
          throw new Error("no call expected");
        },
        wait: (ms, signal) =>
          new Promise((resolve, reject) => {
            const timer = setTimeout(resolve, ms);
            signal.addEventListener("abort", () => {
              clearTimeout(timer);
              reject(signal.reason);
            });
          }),
      }),
  );
}

function request(method: string, path: string, body?: Uint8Array): Request {
  return new Request(`http://host.test${path}`, {
    method,
    body: body === undefined ? undefined : Buffer.from(body),
  });
}

async function call(
  injectors: MicInjectors,
  method: string,
  path: string,
  options: { body?: Uint8Array; serial?: string; decode?: () => Promise<Buffer> } = {},
) {
  const url = new URL(`http://host.test${path}`);
  const response = await handleMicrophoneRequest(request(method, path, options.body), url, {
    serial: options.serial ?? SERIAL,
    injectors,
    decode: options.decode ?? (async () => PCM),
  });
  return response!;
}

describe("handleMicrophoneRequest", () => {
  test("ignores other paths", async () => {
    const url = new URL("http://host.test/api/camera");
    expect(
      await handleMicrophoneRequest(request("GET", "/api/camera"), url, {
        serial: SERIAL,
        injectors: quietInjectors(),
      }),
    ).toBeNull();
  });

  test("reports an idle microphone before any audio plays", async () => {
    const injectors = quietInjectors();
    const response = await call(injectors, "GET", "/api/microphone");
    expect(parseMicrophoneStatusResponse(await response.json()).microphone).toEqual({
      serial: SERIAL,
      supported: true,
      stream: "idle",
      source: { kind: "silence" },
      lastError: null,
    });
    await injectors.disposeAll();
  });

  test("plays uploaded audio with its label and loop flag, then stops it", async () => {
    const injectors = quietInjectors();
    const decoded: number[] = [];
    const played = await call(injectors, "POST", "/api/microphone/audio?loop=true&label=voice", {
      body: new Uint8Array([1, 2, 3]),
      decode: async () => {
        decoded.push(1);
        return PCM;
      },
    });
    expect(played.status).toBe(200);
    expect(decoded).toEqual([1]);
    expect(parseMicrophoneStatusResponse(await played.json()).microphone).toMatchObject({
      stream: "waiting",
      source: { kind: "audio", label: "voice", loop: true, positionMs: 0, durationMs: 1000 },
    });

    const stopped = await call(injectors, "DELETE", "/api/microphone/audio");
    const status = parseMicrophoneStatusResponse(await stopped.json()).microphone;
    // The injector keeps waiting, so the call stays armed for the next recording.
    expect(status).toMatchObject({ stream: "waiting", source: { kind: "silence" } });
    await injectors.disposeAll();
  });

  test("rejects bad input with 400 and a physical device with 409", async () => {
    const injectors = quietInjectors();
    const badLoop = await call(injectors, "POST", "/api/microphone/audio?loop=yes", {
      body: new Uint8Array([1]),
    });
    expect(badLoop.status).toBe(400);
    expect(await badLoop.json()).toEqual({ ok: false, error: "loop must be true or false" });

    const badFile = await call(injectors, "POST", "/api/microphone/audio", {
      body: new Uint8Array([1]),
      decode: async () => {
        throw new MicAudioError("cannot decode the audio file");
      },
    });
    expect(badFile.status).toBe(400);

    const physical = await call(injectors, "POST", "/api/microphone/audio", {
      body: new Uint8Array([1]),
      serial: "R58M123456",
    });
    expect(physical.status).toBe(409);
    expect(injectors.status("R58M123456")).toMatchObject({ supported: false, stream: "idle" });
    await injectors.disposeAll();
  });

  test("allows only the documented methods", async () => {
    const injectors = quietInjectors();
    expect((await call(injectors, "POST", "/api/microphone")).status).toBe(405);
    expect((await call(injectors, "GET", "/api/microphone/audio")).status).toBe(405);
  });
});

describe("middleware microphone routes", () => {
  test("serve the microphone without starting a stream session", async () => {
    const created: string[] = [];
    const devices: Device[] = [{ serial: SERIAL, state: "device" }];
    const injectors = quietInjectors();
    const router = createRouter(
      {},
      {
        micInjectors: injectors,
        listDevices: async () => devices,
        listAllDevices: async () => devices,
        createApp: async ({ serial }) => {
          created.push(serial);
          return {} as EmuApp;
        },
      },
    );
    const status = await router.handleRequest(new Request("http://router.test/api/microphone"));
    expect(parseMicrophoneStatusResponse(await status!.json()).microphone.serial).toBe(SERIAL);

    // A WAV header with no data chunk is the caller's fault.
    const bad = await router.handleRequest(
      new Request("http://router.test/api/microphone/audio", {
        method: "POST",
        body: new TextEncoder().encode("RIFF\u0004\u0000\u0000\u0000WAVE"),
      }),
    );
    expect(bad!.status).toBe(400);
    expect(created).toEqual([]);
    await router.stopAll();
  });
});
