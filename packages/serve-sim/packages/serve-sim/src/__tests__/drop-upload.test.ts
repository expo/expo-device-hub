import { beforeEach, describe, expect, mock, test } from "bun:test";

// drop.ts talks to the host through typed actions now, so record those instead of shell strings.
interface RecordedAction {
  action: string;
  params: Record<string, unknown>;
}
const actions: RecordedAction[] = [];
let chunkResult = { stdout: "", stderr: "", exitCode: 0 };

void mock.module("../client/utils/exec", () => ({
  runHostAction: async (action: string, params: Record<string, unknown> = {}) => {
    actions.push({ action, params });
    if (action === "upload.append") {
      return chunkResult.exitCode === 0
        ? { stdout: `/tmp/serve-sim-uploads/${String(params.uploadId)}`, stderr: "", exitCode: 0 }
        : chunkResult;
    }
    return { stdout: "", stderr: "", exitCode: 0 };
  },
}));

import {
  DROP_CHUNK_BYTES,
  arrayBufferToBase64,
  uploadDroppedFile,
  uploadFileToTmp,
} from "../client/utils/drop";
beforeEach(() => {
  actions.length = 0;
  chunkResult = { stdout: "", stderr: "", exitCode: 0 };
});

function chunks(): RecordedAction[] {
  return actions.filter((a) => a.action === "upload.append");
}

/** Decode the base64 payload a chunk action carried. */
function chunkBytes(entry: RecordedAction): Uint8Array {
  const bin = atob(String(entry.params.data));
  const bytes = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
  return bytes;
}

function patternBytes(size: number): Uint8Array<ArrayBuffer> {
  const bytes = new Uint8Array(new ArrayBuffer(size));
  for (let i = 0; i < size; i++) bytes[i] = (i * 31 + 7) % 256;
  return bytes;
}

describe("arrayBufferToBase64", () => {
  test("matches btoa for small input", () => {
    const bytes = new Uint8Array([0, 1, 2, 250, 251, 252, 253, 254, 255]);
    expect(arrayBufferToBase64(bytes.buffer)).toBe(btoa(String.fromCharCode(...bytes)));
  });

  test("round-trips across the 32KB block boundary", () => {
    const bytes = patternBytes(0x8000 * 2 + 13);
    const decoded = atob(arrayBufferToBase64(bytes.buffer));
    expect(decoded.length).toBe(bytes.length);
    for (let i = 0; i < bytes.length; i++) {
      if (decoded.charCodeAt(i) !== bytes[i]) {
        throw new Error(`byte ${i} mismatch`);
      }
    }
  });
});

describe("uploadDroppedFile", () => {
  test("chunked writes reconstruct the original file, then addmedia + cleanup", async () => {
    // 2.5 chunks so the loop exercises both the > create and >> append paths.
    const original = patternBytes(Math.floor(DROP_CHUNK_BYTES * 2.5));
    const file = new File([original], "shot.png", { type: "image/png" });
    const progress: Array<number | null> = [];

    await uploadDroppedFile(file, "media", "UDID", (p) => progress.push(p));

    const chunkActions = chunks();
    expect(chunkActions.length).toBe(3);
    expect(chunkActions[0]!.params.first).toBe(true);
    expect(chunkActions[1]!.params.first).toBe(false);

    const reassembled = new Uint8Array(original.length);
    let offset = 0;
    for (const entry of chunkActions) {
      const bytes = chunkBytes(entry);
      // Each slice is encoded and shipped independently, so no chunk should
      // ever exceed the slice size (the whole file is never materialized).
      expect(bytes.length).toBeLessThanOrEqual(DROP_CHUNK_BYTES);
      reassembled.set(bytes, offset);
      offset += bytes.length;
    }
    expect(offset).toBe(original.length);
    expect(reassembled).toEqual(original);

    expect(actions.some((a) => a.action === "media.add" && a.params.udid === "UDID")).toBe(true);
    expect(actions.some((a) => a.action === "upload.remove")).toBe(true);

    // Progress climbs monotonically, then flips to indeterminate for addmedia.
    expect(progress[0]).toBe(0);
    expect(progress[progress.length - 1]).toBeNull();
    const fractions = progress.filter((p): p is number => p !== null);
    for (let i = 1; i < fractions.length; i++) {
      expect(fractions[i]!).toBeGreaterThan(fractions[i - 1]!);
    }
    expect(fractions[fractions.length - 1]).toBe(1);
  });

  test("ipa drops install instead of addmedia", async () => {
    const file = new File([patternBytes(64)], "app.ipa", { type: "" });
    await uploadDroppedFile(file, "ipa", "UDID", () => {});
    expect(actions.some((a) => a.action === "app.install" && a.params.udid === "UDID")).toBe(true);
    expect(actions.some((a) => a.action === "media.add")).toBe(false);
  });

  test("failed chunk write surfaces stderr and still cleans up", async () => {
    chunkResult = { stdout: "", stderr: "disk full", exitCode: 1 };
    const file = new File([patternBytes(64)], "shot.png", { type: "image/png" });
    await expect(uploadDroppedFile(file, "media", "UDID", () => {})).rejects.toThrow("disk full");
    expect(actions.some((a) => a.action === "upload.remove")).toBe(true);
  });
});

describe("uploadFileToTmp", () => {
  test("stages the file under the upload dir with the given prefix and extension", async () => {
    const original = patternBytes(DROP_CHUNK_BYTES + 100);
    const file = new File([original], "src.jpg", { type: "image/jpeg" });
    const hostPath = await uploadFileToTmp(file, "serve-sim-camsrc", "jpg");
    expect(hostPath).toMatch(/serve-sim-camsrc-.*\.jpg$/);

    const chunkActions = chunks();
    expect(chunkActions.length).toBe(2);
    const total = chunkActions.reduce((sum, entry) => sum + chunkBytes(entry).length, 0);
    expect(total).toBe(original.length);
  });
});
