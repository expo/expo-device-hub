import { createRequire } from "node:module";
import { randomUUID } from "node:crypto";
import { listPhysicalDevices } from "@expo/hub-apple-utils";
import { SERVER_PLATFORM_FILTER } from "./platform-filter";
import { serveSimAllowsOrigin } from "./serve-sim-options";
import { isSessionDevice, SERVER_SINGLE_DEVICE } from "./single-device";

type Configuration = {
  revision: number;
  width: number;
  height: number;
  displayWidth?: number;
  displayHeight?: number;
  codec: string;
  description: Buffer;
};
type Batch = {
  generation: number;
  configuration?: Configuration;
  frames: { data: Buffer; timestamp: number; key: boolean }[];
  dropped: number;
};
type Touch = { phase: number; x: number; y: number; width: number; height: number };
export interface PhysicalCapture {
  read(): Promise<Batch>;
  touch(samples: Touch[], generation: number): Promise<void>;
  requestKeyframe(): void;
  close(): Promise<void>;
}

function openCapture(udid: string): Promise<PhysicalCapture> {
  if (process.platform !== "darwin" || process.arch !== "arm64") {
    throw new Error("Physical iOS mirroring requires an Apple Silicon Mac with Xcode 27 or later.");
  }
  let addon;
  try {
    addon = createRequire(import.meta.url)(
      new URL("../../native/ios-device/ios-device.node", import.meta.url).pathname,
    );
  } catch {
    throw new Error(
      "Build physical iOS support first: bun run --filter expo-device-hub build:ios-device",
    );
  }
  return addon.openDevice(udid);
}

type Session = {
  capture: PhysicalCapture;
  udid: string;
  model: string;
  expires: number;
  reading: boolean;
  inputting: boolean;
  generation?: number;
  closed: boolean;
};
const MAX_BODY = 32 * 1024;

/** Every viewer owns its capture; closing it stops only the stream IDs it opened. */
// @ref LLP 0015#session-ownership — isolate viewers and release abandoned captures.
export function createPhysicalIosHandler(open = openCapture, discover = listPhysicalDevices) {
  const sessions = new Map<string, Session>();
  let opening = 0;
  let disposed = false;
  const close = async (id: string) => {
    const session = sessions.get(id);
    if (!session) return;
    sessions.delete(id);
    session.closed = true;
    await session.capture.close();
  };
  const expiry = setInterval(() => {
    for (const [id, session] of sessions) {
      if (session.expires < Date.now()) void close(id).catch(() => {});
    }
  }, 5_000);
  expiry.unref();
  const json = (value: unknown, status = 200) =>
    Response.json(value, { status, headers: { "Cache-Control": "no-store" } });

  return {
    async dispose() {
      disposed = true;
      clearInterval(expiry);
      await Promise.allSettled([...sessions.keys()].map(close));
    },
    // The caller sets authenticated only after the Hub session-token gate succeeds.
    async handle(request: Request, authenticated = false): Promise<Response> {
      const url = new URL(request.url);
      if (SERVER_PLATFORM_FILTER === "android" || SERVER_SINGLE_DEVICE?.platform === "android")
        return json({ error: "Device is outside this session." }, 403);
      if (request.method !== "POST") return json({ error: "Method Not Allowed" }, 405);
      // Host supplies url.origin, so matching Origin alone does not stop DNS rebinding.
      // Reuse the existing loopback allowlist; other hosts require the Hub token gate.
      if (!authenticated && !serveSimAllowsOrigin([], url))
        return json(
          { error: "Physical iOS preview requires a localhost URL or --require-token." },
          403,
        );
      const origin = request.headers.get("origin");
      if (
        (origin && origin !== url.origin) ||
        request.headers.get("sec-fetch-site") === "cross-site"
      )
        return json({ error: "Origin not allowed." }, 403);
      let body: any;
      try {
        const reader = request.body?.getReader();
        let bytes = 0;
        const chunks: Uint8Array[] = [];
        if (reader)
          while (true) {
            const { done, value } = await reader.read();
            if (done) break;
            bytes += value.length;
            if (bytes > MAX_BODY) {
              await reader.cancel();
              return json({ error: "Request too large." }, 413);
            }
            chunks.push(value);
          }
        body = JSON.parse(Buffer.concat(chunks).toString("utf8"));
        if (!body || typeof body !== "object") throw new Error("Invalid body");
      } catch {
        return json({ error: "Expected JSON body." }, 400);
      }
      let model: string | undefined;
      try {
        if (disposed) return json({ error: "Device server is stopping." }, 503);
        if (url.pathname.endsWith("/open")) {
          if (
            typeof body.device !== "string" ||
            !isSessionDevice(SERVER_SINGLE_DEVICE, "ios", body.device)
          )
            return json({ error: "Invalid device." }, 400);
          if (sessions.size + opening >= 4)
            return json({ error: "Close another physical iOS preview first." }, 429);
          opening++;
          try {
            const listed = await discover();
            const device = listed.value.find(
              (device) => device.udid === body.device && device.connected,
            );
            if (!device)
              return json(
                {
                  error:
                    "Device disconnected. Unlock it, enable Developer Mode, and pair it in Xcode.",
                },
                409,
              );
            model = device.model;
            const capture = await open(body.device);
            if (disposed || request.signal.aborted) {
              await capture.close();
              return json({ error: "Preview closed." }, 409);
            }
            const id = randomUUID();
            sessions.set(id, {
              capture,
              udid: body.device,
              model,
              expires: Date.now() + 30_000,
              reading: false,
              inputting: false,
              closed: false,
            });
            return json({ session: id });
          } finally {
            opening--;
          }
        }
        const session = sessions.get(body.session);
        if (!session || session.expires < Date.now())
          return json({ error: "Preview expired. Reconnect the device." }, 410);
        model = session.model;
        session.expires = Date.now() + 30_000;
        if (url.pathname.endsWith("/close")) {
          await close(body.session);
          return json({ ok: true });
        }
        if (url.pathname.endsWith("/read")) {
          if (session.reading) return json({ error: "A video read is already pending." }, 409);
          session.reading = true;
          try {
            const batch = await session.capture.read();
            if (session.closed) return json({ error: "Preview closed." }, 410);
            if (batch.generation !== session.generation) session.generation = undefined;
            if (batch.frames.some((frame) => frame.key)) session.generation = batch.generation;
            return json({
              ...batch,
              configuration: batch.configuration && {
                ...batch.configuration,
                description: batch.configuration.description.toString("base64"),
              },
              frames: batch.frames.map((frame) => ({
                ...frame,
                data: frame.data.toString("base64"),
              })),
            });
          } finally {
            session.reading = false;
          }
        }
        if (url.pathname.endsWith("/reset")) {
          session.generation = undefined;
          session.capture.requestKeyframe();
          return json({ ok: true });
        }
        if (url.pathname.endsWith("/input")) {
          if (!Number.isInteger(body.generation) || body.generation !== session.generation)
            return json({ error: "Wait for a fresh device frame." }, 409);
          if (!validTouches(body.samples)) return json({ error: "Invalid touch samples." }, 400);
          if (session.inputting) return json({ error: "Input is already pending." }, 409);
          session.inputting = true;
          try {
            await session.capture.touch(
              body.samples.map((sample: Touch) => ({
                ...sample,
                x: sample.x * sample.width,
                y: sample.y * sample.height,
              })),
              body.generation,
            );
          } catch (error) {
            // Native recovery can advance the generation between /read and /input.
            if (
              error instanceof Error &&
              error.message === "Wait for a fresh physical iOS screen before sending input."
            ) {
              session.generation = undefined;
              session.capture.requestKeyframe();
              return json({ error: error.message }, 409);
            }
            throw error;
          } finally {
            session.inputting = false;
          }
          return json({ ok: true });
        }
        return json({ error: "Unknown physical iOS operation." }, 404);
      } catch (error) {
        if (typeof body.session === "string") await close(body.session).catch(() => {});
        const message = error instanceof Error ? error.message : String(error);
        return json({ error: model ? `${model}: ${message}` : message }, 503);
      }
    },
  };
}

function validTouches(samples: unknown): samples is Touch[] {
  return (
    Array.isArray(samples) &&
    samples.length > 0 &&
    samples.length <= 64 &&
    samples.every(
      (sample) =>
        sample &&
        [0, 1, 2].includes(sample.phase) &&
        [sample.x, sample.y].every(
          (n) => typeof n === "number" && Number.isFinite(n) && n >= 0 && n <= 1,
        ) &&
        [sample.width, sample.height].every((n) => Number.isInteger(n) && n > 0 && n <= 16384),
    )
  );
}

export const physicalIos = createPhysicalIosHandler();
