import { describe, expect, test } from "bun:test";

import {
  type MirrorStorage,
  type MirrorUpload,
  type NpmDist,
  mirrorReleaseAsync,
  npmTarballName,
  parseMirrorUrl,
  sha512Integrity,
} from "./npm-mirror.ts";

const encoder = new TextEncoder();
const TARBALL = encoder.encode("expo-device-hub 0.24.0 tarball");

function npmDistFor(bytes: Uint8Array, version = "0.24.0"): NpmDist {
  return {
    integrity: sha512Integrity(bytes),
    shasum: "ff556b0858baea6125fe07bcb86c1441d41c80aa",
    tarball: `https://registry.npmjs.org/expo-device-hub/-/expo-device-hub-${version}.tgz`,
  };
}

type StoredObject = { bytes: Uint8Array; generation: number; upload: MirrorUpload };

/** An in-memory bucket that enforces generation preconditions like GCS. */
function createStorage(files: Record<string, Uint8Array> = {}) {
  const objects = new Map<string, StoredObject>();
  const uploads: string[] = [];
  let nextGeneration = 100;
  let publicOverride: Uint8Array | undefined;
  const put = (path: string, bytes: Uint8Array, upload: MirrorUpload) => {
    const current = objects.get(path);
    if (String(current?.generation ?? 0) !== upload.ifGenerationMatch) {
      throw new Error(`412 Precondition Failed: ${path}`);
    }
    objects.set(path, { bytes, generation: nextGeneration++, upload });
    uploads.push(path);
  };
  const storage: MirrorStorage = {
    async generationAsync(path) {
      const object = objects.get(path);
      return object ? String(object.generation) : undefined;
    },
    async readTextAsync(path) {
      const object = objects.get(path);
      if (!object) throw new Error(`404 ${path}`);
      return new TextDecoder().decode(object.bytes);
    },
    async uploadFileAsync(path, localPath, upload) {
      const bytes = files[localPath];
      if (!bytes) throw new Error(`No local file ${localPath}`);
      put(path, bytes, upload);
    },
    async uploadTextAsync(path, text, upload) {
      put(path, encoder.encode(text), upload);
    },
    async fetchPublicAsync(path) {
      if (publicOverride) return publicOverride;
      const object = objects.get(path);
      if (!object) throw new Error(`404 ${path}`);
      return object.bytes;
    },
  };
  return {
    storage,
    objects,
    uploads,
    setPublicBytes(bytes: Uint8Array) {
      publicOverride = bytes;
    },
    seed(path: string, value: unknown) {
      objects.set(path, {
        bytes: encoder.encode(JSON.stringify(value)),
        generation: nextGeneration++,
        upload: { ifGenerationMatch: "0", cacheControl: "", contentType: "" },
      });
    },
    json(path: string) {
      return JSON.parse(new TextDecoder().decode(objects.get(path)!.bytes));
    },
  };
}

function mirror(
  bucket: ReturnType<typeof createStorage>,
  { version = "0.24.0", bytes = TARBALL, npmDist = npmDistFor(TARBALL, version) } = {},
) {
  return mirrorReleaseAsync({
    name: "expo-device-hub",
    version,
    tarball: { path: "/tmp/pack/expo-device-hub.tgz", bytes },
    npmDist,
    storage: bucket.storage,
    log: () => {},
  });
}

describe("parseMirrorUrl", () => {
  test("derives the public URL that EAS workers read", () => {
    expect(parseMirrorUrl("gs://turtle-v2/npm/")).toEqual({
      bucket: "turtle-v2",
      prefix: "npm",
      publicBaseUrl: "https://storage.googleapis.com/turtle-v2/npm",
    });
  });

  test("rejects a URL that is not gs://", () => {
    expect(() => parseMirrorUrl("https://storage.googleapis.com/turtle-v2/npm")).toThrow(
      "gs://<bucket>/<prefix>",
    );
  });
});

describe("npmTarballName", () => {
  test("keeps npm's file name of a scoped package", () => {
    expect(
      npmTarballName({
        ...npmDistFor(TARBALL),
        tarball: "https://registry.npmjs.org/@expo/serve-sim/-/serve-sim-0.14.3.tgz",
      }),
    ).toBe("serve-sim-0.14.3.tgz");
  });
});

describe("mirrorReleaseAsync", () => {
  test("uploads the tarball, the version record, and then the pointer", async () => {
    const bucket = createStorage({ "/tmp/pack/expo-device-hub.tgz": TARBALL });

    expect(await mirror(bucket)).toEqual({ pointerMoved: true });

    expect(bucket.uploads).toEqual([
      "expo-device-hub/-/expo-device-hub-0.24.0.tgz",
      "expo-device-hub/0.24.0.json",
      "expo-device-hub/latest.json",
    ]);
    expect(bucket.json("expo-device-hub/latest.json")).toEqual({
      name: "expo-device-hub",
      version: "0.24.0",
      tarball: "-/expo-device-hub-0.24.0.tgz",
      integrity: sha512Integrity(TARBALL),
      shasum: "ff556b0858baea6125fe07bcb86c1441d41c80aa",
    });
    expect(bucket.objects.get("expo-device-hub/latest.json")!.upload).toEqual({
      ifGenerationMatch: "0",
      cacheControl: "no-cache, max-age=0",
      contentType: "application/json",
    });
    expect(
      bucket.objects.get("expo-device-hub/-/expo-device-hub-0.24.0.tgz")!.upload.ifGenerationMatch,
    ).toBe("0");
  });

  test("uploads nothing when the packed tarball is not the one on npm", async () => {
    const bucket = createStorage({ "/tmp/pack/expo-device-hub.tgz": TARBALL });

    await expect(
      mirror(bucket, { npmDist: npmDistFor(encoder.encode("other bytes")) }),
    ).rejects.toThrow("is not the tarball on npm");

    expect(bucket.uploads).toEqual([]);
  });

  test("keeps the pointer when the public copy reads back with another sha512", async () => {
    const bucket = createStorage({ "/tmp/pack/expo-device-hub.tgz": TARBALL });
    bucket.setPublicBytes(encoder.encode("truncated"));

    await expect(mirror(bucket)).rejects.toThrow("latest.json was not changed");

    expect(bucket.uploads).toEqual(["expo-device-hub/-/expo-device-hub-0.24.0.tgz"]);
  });

  test("checks an existing tarball and version record instead of replacing them", async () => {
    const bucket = createStorage({ "/tmp/pack/expo-device-hub.tgz": TARBALL });
    await mirror(bucket);
    bucket.uploads.length = 0;

    expect(await mirror(bucket)).toEqual({ pointerMoved: false });

    expect(bucket.uploads).toEqual([]);
  });

  test("stops when the version record exists with another sha512", async () => {
    const bucket = createStorage({ "/tmp/pack/expo-device-hub.tgz": TARBALL });
    bucket.seed("expo-device-hub/0.24.0.json", {
      name: "expo-device-hub",
      version: "0.24.0",
      tarball: "-/expo-device-hub-0.24.0.tgz",
      integrity: "sha512-other",
      shasum: "other",
    });

    await expect(mirror(bucket)).rejects.toThrow("exists with other content");

    expect(bucket.uploads).not.toContain("expo-device-hub/latest.json");
  });

  test("does not move the pointer back to an older release", async () => {
    const bucket = createStorage({ "/tmp/pack/expo-device-hub.tgz": TARBALL });
    bucket.seed("expo-device-hub/latest.json", { name: "expo-device-hub", version: "0.25.0" });

    expect(await mirror(bucket)).toEqual({ pointerMoved: false });

    expect(bucket.json("expo-device-hub/latest.json").version).toBe("0.25.0");
  });

  test("moves the pointer forward with the generation that it read", async () => {
    const bucket = createStorage({ "/tmp/pack/expo-device-hub.tgz": TARBALL });
    bucket.seed("expo-device-hub/latest.json", { name: "expo-device-hub", version: "0.9.1" });
    const generation = String(bucket.objects.get("expo-device-hub/latest.json")!.generation);

    expect(await mirror(bucket)).toEqual({ pointerMoved: true });

    expect(bucket.objects.get("expo-device-hub/latest.json")!.upload.ifGenerationMatch).toBe(
      generation,
    );
    expect(bucket.json("expo-device-hub/latest.json").version).toBe("0.24.0");
  });

  test("fails when another release moved the pointer after it was read", async () => {
    const bucket = createStorage({ "/tmp/pack/expo-device-hub.tgz": TARBALL });
    bucket.seed("expo-device-hub/latest.json", { name: "expo-device-hub", version: "0.23.0" });
    const readTextAsync = bucket.storage.readTextAsync.bind(bucket.storage);
    bucket.storage.readTextAsync = async (path) => {
      const text = await readTextAsync(path);
      if (path.endsWith("latest.json")) {
        // Another run writes the pointer between this run's read and its write.
        bucket.seed("expo-device-hub/latest.json", { name: "expo-device-hub", version: "0.24.1" });
      }
      return text;
    };

    await expect(mirror(bucket)).rejects.toThrow("412 Precondition Failed");

    expect(bucket.json("expo-device-hub/latest.json").version).toBe("0.24.1");
  });
});
