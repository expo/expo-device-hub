import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, test } from "bun:test";
import type { ExecResult } from "../src/exec.ts";
import { decodeMicAudioFile, decodeWav, floatToPcm16, resampleLinear } from "../src/mic-audio.ts";

type WavOptions = {
  tag?: number;
  channels: number;
  sampleRate: number;
  bitsPerSample: number;
  data: Buffer;
  /** Extra chunks before `data`, such as an odd-sized LIST chunk. */
  extra?: Buffer;
};

function wav(options: WavOptions): Buffer {
  const fmt = Buffer.alloc(24);
  fmt.write("fmt ", 0, "ascii");
  fmt.writeUInt32LE(16, 4);
  fmt.writeUInt16LE(options.tag ?? 1, 8);
  fmt.writeUInt16LE(options.channels, 10);
  fmt.writeUInt32LE(options.sampleRate, 12);
  const blockAlign = (options.bitsPerSample / 8) * options.channels;
  fmt.writeUInt32LE(options.sampleRate * blockAlign, 16);
  fmt.writeUInt16LE(blockAlign, 20);
  fmt.writeUInt16LE(options.bitsPerSample, 22);
  const dataHeader = Buffer.alloc(8);
  dataHeader.write("data", 0, "ascii");
  dataHeader.writeUInt32LE(options.data.length, 4);
  const body = Buffer.concat([fmt, options.extra ?? Buffer.alloc(0), dataHeader, options.data]);
  const header = Buffer.alloc(12);
  header.write("RIFF", 0, "ascii");
  header.writeUInt32LE(4 + body.length, 4);
  header.write("WAVE", 8, "ascii");
  return Buffer.concat([header, body]);
}

function samples(pcm: Buffer): number[] {
  const values: number[] = [];
  for (let offset = 0; offset + 1 < pcm.length; offset += 2) values.push(pcm.readInt16LE(offset));
  return values;
}

describe("decodeWav", () => {
  test("keeps 44.1 kHz mono 16-bit samples as they are", () => {
    const data = Buffer.alloc(8);
    [0, 1000, -1000, 32_767].forEach((value, index) => data.writeInt16LE(value, index * 2));
    expect(
      samples(decodeWav(wav({ channels: 1, sampleRate: 44_100, bitsPerSample: 16, data }))),
    ).toEqual([0, 1000, -1000, 32_767]);
  });

  test("mixes stereo down to mono", () => {
    const data = Buffer.alloc(8);
    [1000, 3000, -2000, 0].forEach((value, index) => data.writeInt16LE(value, index * 2));
    expect(
      samples(decodeWav(wav({ channels: 2, sampleRate: 44_100, bitsPerSample: 16, data }))),
    ).toEqual([2000, -1000]);
  });

  test("reads 8-bit, 24-bit, and float samples", () => {
    const eight = Buffer.from([128, 255, 0]);
    expect(
      samples(decodeWav(wav({ channels: 1, sampleRate: 44_100, bitsPerSample: 8, data: eight }))),
    ).toEqual([0, 32_512, -32_768]);
    const twentyFour = Buffer.alloc(3);
    twentyFour.writeIntLE(-4_194_304, 0, 3);
    expect(
      samples(
        decodeWav(wav({ channels: 1, sampleRate: 44_100, bitsPerSample: 24, data: twentyFour })),
      ),
    ).toEqual([-16_384]);
    const float = Buffer.alloc(8);
    float.writeFloatLE(0.5, 0);
    float.writeFloatLE(-2, 4);
    expect(
      samples(
        decodeWav(wav({ tag: 3, channels: 1, sampleRate: 44_100, bitsPerSample: 32, data: float })),
      ),
    ).toEqual([16_384, -32_768]);
  });

  test("resamples to 44.1 kHz", () => {
    const data = Buffer.alloc(48_000 * 2);
    const pcm = decodeWav(wav({ channels: 1, sampleRate: 48_000, bitsPerSample: 16, data }));
    expect(pcm.length).toBe(44_100 * 2);
  });

  test("skips odd-sized chunks with their pad byte", () => {
    const list = Buffer.alloc(8 + 3 + 1);
    list.write("LIST", 0, "ascii");
    list.writeUInt32LE(3, 4);
    const data = Buffer.alloc(2);
    data.writeInt16LE(1234, 0);
    expect(
      samples(
        decodeWav(wav({ channels: 1, sampleRate: 44_100, bitsPerSample: 16, data, extra: list })),
      ),
    ).toEqual([1234]);
  });

  test("rejects compressed and invalid WAV files", () => {
    expect(() =>
      decodeWav(
        wav({ tag: 2, channels: 1, sampleRate: 44_100, bitsPerSample: 4, data: Buffer.alloc(4) }),
      ),
    ).toThrow("is not PCM");
    expect(() =>
      decodeWav(wav({ channels: 0, sampleRate: 44_100, bitsPerSample: 16, data: Buffer.alloc(4) })),
    ).toThrow("unsupported WAV format");
    expect(() => decodeWav(Buffer.from("not audio"))).toThrow("not a RIFF/WAVE file");
  });
});

describe("resampleLinear and floatToPcm16", () => {
  test("interpolates between samples and clamps to 16 bits", () => {
    expect([...resampleLinear(new Float32Array([0, 1]), 1, 2)]).toEqual([0, 0.5, 1, 1]);
    expect(samples(floatToPcm16(new Float32Array([2, -2, 0])))).toEqual([32_767, -32_768, 0]);
  });
});

describe("decodeMicAudioFile", () => {
  const directory = mkdtempSync(join(tmpdir(), "serve-emu-mic-test-"));
  afterAll(() => rmSync(directory, { recursive: true, force: true }));
  const result = <T extends string | Buffer>(
    overrides: Partial<ExecResult<T>> & { stdout: T },
  ): ExecResult<T> => ({
    status: 0,
    signal: null,
    stderr: "",
    timedOut: false,
    error: null,
    ...overrides,
  });

  test("decodes a WAV file without a converter", async () => {
    const path = join(directory, "tone.wav");
    const data = Buffer.alloc(4);
    data.writeInt16LE(42, 0);
    writeFileSync(path, wav({ channels: 1, sampleRate: 44_100, bitsPerSample: 16, data }));
    const pcm = await decodeMicAudioFile(path, undefined, {
      runBuffer: (async () => {
        throw new Error("no converter expected");
      }) as never,
    });
    expect(samples(pcm)).toEqual([42, 0]);
  });

  test("asks ffmpeg for 44.1 kHz mono 16-bit PCM", async () => {
    const path = join(directory, "voice.m4a");
    writeFileSync(path, "fake m4a");
    let call: { binary: string; args: string[] } | null = null;
    const pcm = await decodeMicAudioFile(path, undefined, {
      resolveFfmpeg: () => "/opt/ffmpeg",
      runBuffer: (async (binary: string, args: string[]) => {
        call = { binary, args };
        return result({ stdout: Buffer.from([1, 0, 2, 0, 9]) });
      }) as never,
    });
    expect(call!.binary).toBe("/opt/ffmpeg");
    expect(call!.args).toContain(path);
    expect(call!.args.join(" ")).toContain("-ac 1 -ar 44100 -f s16le pipe:1");
    // A torn last byte is dropped.
    expect(samples(pcm)).toEqual([1, 2]);
  });

  test("names both converters when neither can decode the file", async () => {
    const path = join(directory, "voice.mp3");
    writeFileSync(path, "fake mp3");
    await expect(
      decodeMicAudioFile(path, undefined, {
        platform: "darwin",
        runBuffer: (async () =>
          result({
            stdout: Buffer.alloc(0),
            status: null,
            error: new Error("spawn ffmpeg ENOENT"),
          })) as never,
        runExec: (async () => result({ stdout: "", status: 1, stderr: "bad format" })) as never,
      }),
    ).rejects.toThrow(
      "use a PCM WAV file, or install ffmpeg (ffmpeg: spawn ffmpeg ENOENT; afconvert: bad format)",
    );
  });
});
