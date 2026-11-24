import { isEmulatorSerial } from "./device-capabilities.ts";
import { decodeMicAudio, MicAudioError, type MicPcm } from "./mic-audio.ts";
import type { MicInjectors } from "./mic-injector.ts";
import { HttpBodyError, readBodyLimited } from "./request-body.ts";
import type { MicrophoneStatus } from "./shared/api-contracts.ts";

/**
 * The largest audio upload: about 50 MB, which holds about 5 minutes of 44.1 kHz stereo WAV.
 * Longer audio can be passed to the CLI as a file.
 */
export const MAX_MIC_AUDIO_UPLOAD_BYTES = 50 * 1024 * 1024;
/** The longest label that the status shows for the playing audio. */
const MAX_LABEL_LENGTH = 200;

/** A request the caller must fix. */
export class MicrophoneInputError extends Error {
  readonly status: 400 | 409;

  constructor(message: string, status: 400 | 409 = 400) {
    super(message);
    this.name = "MicrophoneInputError";
    this.status = status;
  }
}

export function parseMicrophonePlayOptions(params: URLSearchParams): {
  loop: boolean;
  label: string;
} {
  const loop = params.get("loop");
  if (loop !== null && loop !== "true" && loop !== "false") {
    throw new MicrophoneInputError("loop must be true or false");
  }
  const label = params.get("label")?.trim() || "audio";
  if (label.length > MAX_LABEL_LENGTH) {
    throw new MicrophoneInputError(`label must be at most ${MAX_LABEL_LENGTH} characters`);
  }
  return { loop: loop === "true", label };
}

/** Throws when the device cannot take injected audio. */
export function assertMicrophoneSupported(serial: string): void {
  if (!isEmulatorSerial(serial)) {
    throw new MicrophoneInputError(
      `microphone injection needs an Android emulator; ${serial} is not one`,
      409,
    );
  }
}

/** Plays decoded audio into a serial's microphone and returns the new status. */
function playMicrophoneAudio(
  injectors: MicInjectors,
  serial: string,
  pcm: MicPcm,
  options: { loop: boolean; label: string },
): MicrophoneStatus {
  assertMicrophoneSupported(serial);
  return injectors.get(serial).play(pcm, options);
}

/** Sends silence. The open call stays open, so the app keeps recording silence, not an error. */
function stopMicrophoneAudio(injectors: MicInjectors, serial: string): MicrophoneStatus {
  // An idle injector plays nothing. Do not create one, for example for a physical device.
  const status = injectors.status(serial);
  return status.stream === "idle" ? status : injectors.get(serial).stop();
}

export type MicrophoneRequestContext = {
  serial: string;
  injectors: MicInjectors;
  /** Runs before a change, so a host can refuse a request for a device session that ended. */
  beforeMutation?: () => void;
  errorResponse?: (error: unknown) => Response;
  decode?: (bytes: Uint8Array, signal: AbortSignal) => Promise<MicPcm>;
};

/** Input errors are the caller's fault. Anything else failed on this host. */
function defaultMicrophoneErrorResponse(error: unknown): Response {
  if (error instanceof HttpBodyError) {
    return Response.json(
      { ok: false, code: error.code, error: error.message },
      { status: error.status },
    );
  }
  const status =
    error instanceof MicrophoneInputError || error instanceof MicAudioError ? error.status : 500;
  return Response.json(
    { ok: false, error: error instanceof Error ? error.message : String(error) },
    { status },
  );
}

const methodNotAllowed = () => new Response("method not allowed", { status: 405 });

/**
 * A host that must resolve a device serial before it can build the context asks this first,
 * so a request for another path never pays for that resolve.
 */
export function isMicrophonePath(pathname: string): boolean {
  return pathname === "/api/microphone" || pathname === "/api/microphone/audio";
}

/**
 * The one microphone HTTP handler. Both the standalone server and the middleware router mount
 * it, so the routes cannot drift apart.
 */
export async function handleMicrophoneRequest(
  request: Request,
  url: URL,
  context: MicrophoneRequestContext,
): Promise<Response | null> {
  if (!isMicrophonePath(url.pathname)) return null;
  const { serial, injectors } = context;
  const errorResponse = context.errorResponse ?? defaultMicrophoneErrorResponse;
  const respond = (microphone: MicrophoneStatus) => Response.json({ ok: true, microphone });

  if (url.pathname === "/api/microphone") {
    if (request.method !== "GET") return methodNotAllowed();
    return respond(injectors.status(serial));
  }
  if (request.method !== "POST" && request.method !== "DELETE") return methodNotAllowed();

  try {
    if (request.method === "DELETE") {
      context.beforeMutation?.();
      return respond(stopMicrophoneAudio(injectors, serial));
    }
    const options = parseMicrophonePlayOptions(url.searchParams);
    assertMicrophoneSupported(serial);
    const bytes = await readBodyLimited(request, MAX_MIC_AUDIO_UPLOAD_BYTES);
    const decode = context.decode ?? ((audio, signal) => decodeMicAudio(audio, signal));
    const pcm = await decode(bytes, request.signal);
    context.beforeMutation?.();
    return respond(playMicrophoneAudio(injectors, serial, pcm, options));
  } catch (error) {
    return errorResponse(error);
  }
}
