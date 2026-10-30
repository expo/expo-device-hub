import { useCallback, useEffect, useRef, useState } from "react";
import { sessionTokenFetch } from "./session-token";
import type { DeviceClient, DeviceConnectionOptions, ScreenSize, TouchSample } from "./types";
import { NOOP_DEVICE_CLIENT } from "./useNoopDeviceClient";

type Sample = { phase: number; x: number; y: number; width: number; height: number };
const bytes = (value: string) => Uint8Array.from(atob(value), (char) => char.charCodeAt(0));

/** Physical iOS has a different transport and capabilities from CoreSimulator. */
export function usePhysicalIosDeviceClient({
  enabled,
  baseUrl,
  device,
  token,
}: DeviceConnectionOptions): DeviceClient {
  const canvas = useRef<HTMLCanvasElement | null>(null);
  const input = useRef<((sample: TouchSample) => void) | null>(null);
  const [status, setStatus] = useState<DeviceClient["status"]>("idle");
  const [error, setError] = useState<string | null>(null);
  const [inputError, setInputError] = useState<string | null>(null);
  const [screen, setScreen] = useState<ScreenSize | null>(null);
  const attachVideo = useCallback(
    (element: HTMLCanvasElement | HTMLImageElement | HTMLVideoElement | null) => {
      canvas.current = element as HTMLCanvasElement | null;
    },
    [],
  );
  const sendTouch = useCallback((sample: TouchSample) => input.current?.(sample), []);

  useEffect(() => {
    if (!enabled || !baseUrl || !device) return;
    let stopped = false;
    let session: string | null = null;
    let decoder: VideoDecoder | null = null;
    let generation: number | undefined;
    let touchGeneration: number | undefined;
    let configuration: VideoDecoderConfig | null = null;
    let awaitingKey = true;
    let width = 0;
    let height = 0;
    let inputting = false;
    let pending: Sample[] = [];
    const controller = new AbortController();
    const fetchImpl = sessionTokenFetch(token);
    const request = async (operation: string, body: object, cleanup = false) => {
      const response = await fetchImpl(`${baseUrl}/${operation}`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ session, ...body }),
        signal:
          operation === "open"
            ? AbortSignal.timeout(35_000)
            : cleanup
              ? AbortSignal.timeout(5_000)
              : controller.signal,
        keepalive: cleanup && operation !== "open",
      });
      const value = await response.json();
      if (!response.ok)
        throw new Error(value.error ?? `Device request failed (${response.status})`);
      return value;
    };
    const flushInput = async () => {
      if (inputting || stopped || !session || generation === undefined || !pending.length) return;
      inputting = true;
      try {
        while (!stopped && pending.length) {
          const samples = pending.splice(0, 64);
          await request("input", { samples, generation });
        }
        if (!stopped) setInputError(null);
      } catch (error) {
        pending = [];
        touchGeneration = undefined;
        if (!stopped) setInputError(String(error));
      } finally {
        inputting = false;
      }
    };
    const handleInput = (sample: TouchSample) => {
      if (
        stopped ||
        controller.signal.aborted ||
        awaitingKey ||
        generation === undefined ||
        !width ||
        !height
      )
        return;
      // Native recovery releases its contact. Do not send a move/up from the old
      // gesture, or an up whose down was ignored while waiting for a keyframe.
      if (sample.phase === "begin") touchGeneration = generation;
      else if (touchGeneration !== generation) return;
      if (sample.phase === "end") touchGeneration = undefined;
      const next = {
        phase: sample.phase === "begin" ? 0 : sample.phase === "move" ? 1 : 2,
        x: sample.x,
        y: sample.y,
        width,
        height,
      };
      // Coalesce only unsent moves; never drop down/up transitions.
      if (next.phase === 1 && pending.at(-1)?.phase === 1) pending[pending.length - 1] = next;
      else if (pending.length < 64) pending.push(next);
      else {
        pending = [];
        setInputError("Touch queue full. Reconnect the device.");
        setStatus("error");
        // Closing the capture releases any contact whose end could not be queued.
        controller.abort();
        return;
      }
      void flushInput();
    };
    input.current = handleInput;
    setStatus("connecting");
    setError(null);
    setInputError(null);
    setScreen(null);
    const target = canvas.current;
    target?.getContext("2d")?.clearRect(0, 0, target.width, target.height);
    void (async () => {
      try {
        if (typeof VideoDecoder === "undefined")
          throw new Error(
            "This browser cannot decode physical iOS video. Use a browser with HEVC WebCodecs support.",
          );
        // Do not abort the open response: cleanup must learn its ID to close the capture.
        const opened = await request("open", { device }, true);
        session = opened.session;
        if (stopped) {
          await request("close", {}, true);
          return;
        }
        decoder = new VideoDecoder({
          output(frame) {
            try {
              if (stopped || !canvas.current) return;
              const target = canvas.current;
              if (target.width !== width || target.height !== height) {
                target.width = width;
                target.height = height;
              }
              target.getContext("2d")?.drawImage(frame, 0, 0, width, height, 0, 0, width, height);
              setStatus("streaming");
            } finally {
              frame.close();
            }
          },
          error(error) {
            if (!stopped) {
              setError(error.message);
              setStatus("error");
              controller.abort();
            }
          },
        });
        while (!stopped) {
          const batch = await request("read", {});
          if (stopped) break;
          if (batch.configuration) {
            const config = batch.configuration;
            width = config.displayWidth ?? config.width;
            height = config.displayHeight ?? config.height;
            configuration = {
              codec: config.codec,
              codedWidth: config.width,
              codedHeight: config.height,
              description: bytes(config.description),
              optimizeForLatency: true,
              hardwareAcceleration: "prefer-hardware",
            };
            const supported = await VideoDecoder.isConfigSupported(configuration);
            if (!supported.supported)
              throw new Error(
                "HEVC decoding is unavailable in this browser. Open Hub in Chrome or Safari on your Mac.",
              );
            setScreen({ width, height });
            awaitingKey = true;
          }
          if (generation !== batch.generation) {
            generation = batch.generation;
            touchGeneration = undefined;
            awaitingKey = true;
            pending = [];
          }
          if (!configuration) continue;
          if (decoder.decodeQueueSize > 8) {
            decoder.reset();
            awaitingKey = true;
            await request("reset", {});
            continue;
          }
          for (const frame of batch.frames) {
            if (awaitingKey) {
              if (!frame.key) continue;
              decoder.reset();
              decoder.configure(configuration);
              awaitingKey = false;
            }
            decoder.decode(
              new EncodedVideoChunk({
                type: frame.key ? "key" : "delta",
                timestamp: frame.timestamp,
                data: bytes(frame.data),
              }),
            );
          }
        }
      } catch (error) {
        if (!stopped && !controller.signal.aborted) {
          setError(error instanceof Error ? error.message : String(error));
          setStatus("error");
        }
      } finally {
        if (input.current === handleInput) input.current = null;
        if (decoder && decoder.state !== "closed") decoder.close();
        if (session) void request("close", {}, true).catch(() => {});
      }
    })();
    return () => {
      stopped = true;
      controller.abort();
      input.current = null;
      pending = [];
      if (decoder && decoder.state !== "closed") decoder.close();
      if (session) void request("close", {}, true).catch(() => {});
    };
  }, [enabled, baseUrl, device, token]);

  return {
    ...NOOP_DEVICE_CLIENT,
    status,
    error,
    inputError,
    screen,
    videoKind: "canvas",
    attachVideo,
    sendTouch,
    screenshot: async () => {
      const target = canvas.current;
      if (!target || status !== "streaming") return null;
      const blob = await new Promise<Blob | null>((resolve) => target.toBlob(resolve, "image/png"));
      return blob ? { blob, artifact: null } : null;
    },
  };
}
