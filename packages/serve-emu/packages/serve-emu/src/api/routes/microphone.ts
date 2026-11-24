import { MicAudioError } from "../../mic-audio.ts";
import {
  MAX_MIC_AUDIO_UPLOAD_BYTES,
  MicrophoneInputError,
  parseMicrophonePlayOptions,
} from "../../microphone.ts";
import { ApiError } from "../api-error.ts";
import { readBodyBytes } from "../body.ts";
import type { ApiDependencies } from "../dependencies.ts";
import type { ContractApiRoute } from "./types.ts";
import { downstream, invalid, parseInput } from "./route-helpers.ts";

/** A bad audio file or a physical device is the caller's fault, not a downstream failure. */
async function callerErrors<T>(action: () => Promise<T>): Promise<T> {
  try {
    return await action();
  } catch (error) {
    if (error instanceof MicrophoneInputError && error.status === 409) {
      throw new ApiError(409, "conflict", error.message, { cause: error });
    }
    if (error instanceof MicrophoneInputError || error instanceof MicAudioError) {
      invalid(error.message, error);
    }
    throw error;
  }
}

export function microphoneRoutes(): ContractApiRoute<ApiDependencies>[] {
  return [
    {
      method: "GET",
      path: "/api/microphone",
      handler: async ({ deps }) => Response.json({ ok: true, microphone: deps.getMicrophone() }),
    },
    {
      method: "POST",
      path: "/api/microphone/audio",
      handler: async ({ request, url, deps }) => {
        const options = parseInput(() => parseMicrophonePlayOptions(url.searchParams));
        const audio = await readBodyBytes(request, MAX_MIC_AUDIO_UPLOAD_BYTES);
        return Response.json({
          ok: true,
          microphone: await downstream("play microphone audio", () =>
            callerErrors(() => deps.playMicrophoneAudio(audio, options)),
          ),
        });
      },
    },
    {
      method: "DELETE",
      path: "/api/microphone/audio",
      handler: async ({ deps }) =>
        Response.json({ ok: true, microphone: deps.stopMicrophoneAudio() }),
    },
  ];
}
