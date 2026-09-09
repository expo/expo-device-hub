import { existsSync, statSync, writeFileSync } from "node:fs";
import { describe, expect, test } from "bun:test";
import {
  GrpcMmapScreenshotRegion,
  readStableMmapFrame,
  retryMmapCleanupOperation,
  rgb888MmapRegionBytes,
} from "../src/grpc-mmap.ts";

describe("gRPC screenshot mmap region", () => {
  test("creates a private, correctly sized file URL and removes it on close", async () => {
    const region = GrpcMmapScreenshotRegion.create(4_096);
    const { path, directory } = region;
    try {
      expect(region.handle).toStartWith("file:///");
      expect(statSync(path).size).toBe(4_096);
      expect(statSync(path).mode & 0o777).toBe(0o600);

      writeFileSync(path, Buffer.alloc(4_096, 0x5a));
      const read = region.readFrame(32);
      expect(read.image).toEqual(Buffer.alloc(32, 0x5a));
      expect(read.attempts).toBe(1);
      expect(read.bytesRead).toBe(64);
    } finally {
      await region.close();
    }

    expect(existsSync(path)).toBe(false);
    expect(existsSync(directory)).toBe(false);
    expect(() => region.readFrame(1)).toThrow("region is closed");
    await expect(region.close()).resolves.toBeUndefined();
  });

  test("retries transient cleanup races and treats an absent path as removed", async () => {
    let attempts = 0;
    const waits: number[] = [];
    await retryMmapCleanupOperation(
      async () => {
        attempts++;
        if (attempts < 3) {
          throw Object.assign(new Error("mapping still owns the file"), {
            code: "EPERM",
          });
        }
      },
      {
        maxAttempts: 4,
        retryDelayMs: 5,
        sleep: async (delayMs) => {
          waits.push(delayMs);
        },
      },
    );
    expect(attempts).toBe(3);
    expect(waits).toEqual([5, 10]);

    let absentAttempts = 0;
    await retryMmapCleanupOperation(async () => {
      absentAttempts++;
      throw Object.assign(new Error("already removed by emulator"), {
        code: "ENOENT",
      });
    });
    expect(absentAttempts).toBe(1);
  });

  test("retries a changing region and returns only matching copies", () => {
    const generations = [0x11, 0x22, 0x33, 0x33];
    let readCall = 0;
    let now = 10;
    const result = readStableMmapFrame({
      byteLength: 8,
      verificationBuffer: Buffer.alloc(8),
      maxAttempts: 3,
      now: () => now++,
      read(buffer, offset, length) {
        buffer.fill(generations[readCall++]!, offset, offset + length);
        return length;
      },
    });

    expect(result.image).toEqual(Buffer.alloc(8, 0x33));
    expect(result.attempts).toBe(2);
    expect(result.bytesRead).toBe(32);
    expect(result.readMs).toBe(1);
  });

  test("drops a frame that changes throughout the bounded read window", () => {
    let generation = 0;
    const result = readStableMmapFrame({
      byteLength: 4,
      verificationBuffer: Buffer.alloc(4),
      maxAttempts: 3,
      read(buffer, offset, length) {
        buffer.fill(++generation, offset, offset + length);
        return length;
      },
    });

    expect(result.image).toBeNull();
    expect(result.attempts).toBe(3);
    expect(result.bytesRead).toBe(24);
  });

  test("bounds requested dimensions and short reads", () => {
    expect(rgb888MmapRegionBytes(360, 640)).toBe(691_200);
    expect(() => rgb888MmapRegionBytes(0, 640)).toThrow(
      "mmap width must be a positive safe integer",
    );
    expect(() => rgb888MmapRegionBytes(16_384, 16_384)).toThrow(
      "must not exceed",
    );
    expect(() =>
      readStableMmapFrame({
        byteLength: 8,
        verificationBuffer: Buffer.alloc(8),
        read: () => 0,
      }),
    ).toThrow("could not read complete");
  });
});
