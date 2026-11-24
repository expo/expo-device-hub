import { mkdtemp, readFile, rm, rmdir, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AudioFormatRequest } from "./emulator-grpc.ts";
import { execBuffer, execText } from "./exec.ts";
import { resolveFfmpeg } from "./h264-encoder.ts";

/**
 * The format of all microphone audio that serve-emu injects.
 * @ref LLP 0026#android — the guest records at 44.1 kHz; MODE_REAL_TIME needs our own pacing.
 */
export const MIC_FORMAT: AudioFormatRequest = {
  samplingRate: 44_100,
  channels: "mono",
  sampleFormat: "s16",
  mode: "realtime",
};
export const MIC_BYTES_PER_FRAME = 2;
export const MIC_BYTES_PER_SECOND = MIC_FORMAT.samplingRate * MIC_BYTES_PER_FRAME;

/** The longest audio file that serve-emu decodes: 10 minutes, about 53 MB of PCM. */
export const MAX_MIC_AUDIO_SECONDS = 600;
/** The largest audio file that serve-emu reads. */
export const MAX_MIC_AUDIO_FILE_BYTES = 200 * 1024 * 1024;

const CONVERT_TIMEOUT_MS = 60_000;

/** Mono, signed 16-bit little-endian PCM at {@link MIC_FORMAT}'s rate. */
export type MicPcm = Buffer;

type WavFormat = {
  encoding: "int" | "float";
  channels: number;
  sampleRate: number;
  bitsPerSample: number;
  blockAlign: number;
};

const WAVE_FORMAT_PCM = 1;
const WAVE_FORMAT_IEEE_FLOAT = 3;
const WAVE_FORMAT_EXTENSIBLE = 0xfffe;

export function isWav(bytes: Buffer): boolean {
  return (
    bytes.length >= 12 &&
    bytes.toString("ascii", 0, 4) === "RIFF" &&
    bytes.toString("ascii", 8, 12) === "WAVE"
  );
}

/**
 * Decode a PCM or IEEE float WAV file to {@link MicPcm}. Other WAV codecs (for example ADPCM)
 * throw, so the caller can try a converter.
 */
export function decodeWav(bytes: Buffer): MicPcm {
  if (!isWav(bytes)) throw new Error("not a RIFF/WAVE file");
  let format: WavFormat | null = null;
  let data: Buffer | null = null;
  let offset = 12;
  while (offset + 8 <= bytes.length) {
    const id = bytes.toString("ascii", offset, offset + 4);
    const size = bytes.readUInt32LE(offset + 4);
    const start = offset + 8;
    // A streamed WAV can declare a data size larger than the file. Use what is there.
    const end = Math.min(start + size, bytes.length);
    if (id === "fmt ") {
      if (end - start < 16) throw new Error("WAV fmt chunk is too short");
      let tag = bytes.readUInt16LE(start);
      const bitsPerSample = bytes.readUInt16LE(start + 14);
      if (tag === WAVE_FORMAT_EXTENSIBLE && end - start >= 26) {
        tag = bytes.readUInt16LE(start + 24);
      }
      if (tag !== WAVE_FORMAT_PCM && tag !== WAVE_FORMAT_IEEE_FLOAT) {
        throw new Error(`WAV codec 0x${tag.toString(16)} is not PCM`);
      }
      format = {
        encoding: tag === WAVE_FORMAT_IEEE_FLOAT ? "float" : "int",
        channels: bytes.readUInt16LE(start + 2),
        sampleRate: bytes.readUInt32LE(start + 4),
        blockAlign: bytes.readUInt16LE(start + 12),
        bitsPerSample,
      };
    } else if (id === "data") {
      data = bytes.subarray(start, end);
    }
    // Chunks are padded to an even size.
    offset = start + size + (size % 2);
  }
  if (!format) throw new Error("WAV file has no fmt chunk");
  if (!data) throw new Error("WAV file has no data chunk");
  const { encoding, channels, sampleRate, bitsPerSample, blockAlign } = format;
  const valid =
    channels >= 1 &&
    channels <= 8 &&
    sampleRate >= 1_000 &&
    sampleRate <= 384_000 &&
    (encoding === "float"
      ? bitsPerSample === 32 || bitsPerSample === 64
      : [8, 16, 24, 32].includes(bitsPerSample)) &&
    blockAlign === (bitsPerSample / 8) * channels;
  if (!valid) {
    throw new Error(
      `unsupported WAV format: ${encoding} ${bitsPerSample}-bit, ${channels} channels, ${sampleRate} Hz`,
    );
  }
  const frames = Math.floor(data.length / blockAlign);
  if (frames / sampleRate > MAX_MIC_AUDIO_SECONDS) {
    throw new Error(`audio is longer than ${MAX_MIC_AUDIO_SECONDS} s`);
  }
  const bytesPerSample = bitsPerSample / 8;
  const read = (position: number): number => {
    if (encoding === "float") {
      return bitsPerSample === 32 ? data.readFloatLE(position) : data.readDoubleLE(position);
    }
    switch (bitsPerSample) {
      case 8:
        return (data[position]! - 128) / 128;
      case 16:
        return data.readInt16LE(position) / 32_768;
      case 24:
        return data.readIntLE(position, 3) / 8_388_608;
      default:
        return data.readInt32LE(position) / 2_147_483_648;
    }
  };
  // Mix all channels down to mono.
  const mono = new Float32Array(frames);
  for (let frame = 0; frame < frames; frame++) {
    let sum = 0;
    for (let channel = 0; channel < channels; channel++) {
      sum += read(frame * blockAlign + channel * bytesPerSample);
    }
    mono[frame] = sum / channels;
  }
  return floatToPcm16(resampleLinear(mono, sampleRate, MIC_FORMAT.samplingRate));
}

/** Linear interpolation. Enough for a test microphone; it does not filter aliasing. */
export function resampleLinear(
  input: Float32Array,
  fromRate: number,
  toRate: number,
): Float32Array {
  if (fromRate === toRate || input.length === 0) return input;
  const length = Math.max(1, Math.round((input.length * toRate) / fromRate));
  const output = new Float32Array(length);
  const step = fromRate / toRate;
  for (let index = 0; index < length; index++) {
    const position = index * step;
    const left = Math.floor(position);
    const right = Math.min(left + 1, input.length - 1);
    const fraction = position - left;
    output[index] = input[left]! * (1 - fraction) + input[right]! * fraction;
  }
  return output;
}

export function floatToPcm16(samples: Float32Array): MicPcm {
  const output = Buffer.allocUnsafe(samples.length * 2);
  for (let index = 0; index < samples.length; index++) {
    // The same scale as the reader, so 16-bit input passes through unchanged.
    const value = Math.round(samples[index]! * 32_768);
    output.writeInt16LE(Math.max(-32_768, Math.min(32_767, value)), index * 2);
  }
  return output;
}

export type DecodeMicAudioDependencies = {
  runExec?: typeof execText;
  runBuffer?: typeof execBuffer;
  resolveFfmpeg?: () => string;
  platform?: NodeJS.Platform;
};

/**
 * Decode an audio file to {@link MicPcm}. WAV is decoded here. Other formats need FFmpeg
 * (`SERVE_EMU_FFMPEG` or `ffmpeg` on PATH) or, on macOS, `afconvert`.
 */
export async function decodeMicAudioFile(
  path: string,
  signal?: AbortSignal,
  dependencies: DecodeMicAudioDependencies = {},
): Promise<MicPcm> {
  const info = await stat(path);
  if (!info.isFile()) throw new Error(`${path} is not a file`);
  if (info.size > MAX_MIC_AUDIO_FILE_BYTES) {
    throw new Error(`audio file is larger than ${MAX_MIC_AUDIO_FILE_BYTES} bytes`);
  }
  const bytes = await readFile(path);
  if (isWav(bytes)) {
    try {
      return decodeWav(bytes);
    } catch (error) {
      // A WAV with a compressed codec can still be converted below.
      if (!(error instanceof Error) || !/is not PCM/.test(error.message)) throw error;
    }
  }
  return convertWithTool(path, signal, dependencies);
}

async function convertWithTool(
  path: string,
  signal: AbortSignal | undefined,
  dependencies: DecodeMicAudioDependencies,
): Promise<MicPcm> {
  const runExec = dependencies.runExec ?? execText;
  const runBuffer = dependencies.runBuffer ?? execBuffer;
  const failures: string[] = [];
  const ffmpeg = (dependencies.resolveFfmpeg ?? resolveFfmpeg)();
  const maxBuffer = MAX_MIC_AUDIO_SECONDS * MIC_BYTES_PER_SECOND + 1024 * 1024;
  const converted = await runBuffer(
    ffmpeg,
    [
      "-nostdin",
      "-hide_banner",
      "-loglevel",
      "error",
      "-i",
      path,
      "-t",
      String(MAX_MIC_AUDIO_SECONDS),
      "-ac",
      "1",
      "-ar",
      String(MIC_FORMAT.samplingRate),
      "-f",
      "s16le",
      "pipe:1",
    ],
    { timeout: CONVERT_TIMEOUT_MS, maxBuffer, signal, lane: "background" },
  );
  if (converted.status === 0 && !converted.error && converted.stdout.length > 0) {
    // ffmpeg writes whole 16-bit samples; drop a torn last byte if the pipe was cut.
    return converted.stdout.subarray(0, converted.stdout.length - (converted.stdout.length % 2));
  }
  failures.push(
    `ffmpeg: ${converted.error?.message || converted.stderr.trim() || `exit status ${converted.status}`}`,
  );

  if ((dependencies.platform ?? process.platform) === "darwin") {
    const directory = await mkdtemp(join(tmpdir(), "serve-emu-mic-"));
    const output = join(directory, "converted.wav");
    try {
      const result = await runExec(
        "afconvert",
        ["-f", "WAVE", "-d", `LEI16@${MIC_FORMAT.samplingRate}`, "-c", "1", path, output],
        { timeout: CONVERT_TIMEOUT_MS, signal, lane: "background" },
      );
      if (result.status === 0 && !result.error) return decodeWav(await readFile(output));
      failures.push(
        `afconvert: ${result.error?.message || result.stderr.trim() || `exit status ${result.status}`}`,
      );
    } finally {
      await rm(output, { force: true });
      await rmdir(directory).catch(() => {});
    }
  }
  throw new Error(
    `cannot decode ${path}: use a PCM WAV file, or install ffmpeg (${failures.join("; ")})`,
  );
}
