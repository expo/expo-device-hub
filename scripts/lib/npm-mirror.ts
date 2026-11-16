// Copies the npm release tarballs that EAS device sessions run into a public bucket, the npm
// mirror, and moves each package's `latest.json` pointer to the new release. EAS reads the mirror
// first and npm second, so a release that npm does not serve yet, or an npm outage, does not stop
// a session.
// @ref LLP 0019#bucket-layout — The layout and pointer format that EAS build-tools reads

import { createHash } from "node:crypto";

/** The packages that EAS device sessions start with `@latest`. */
export const MIRRORED_PACKAGES = ["expo-device-hub", "@expo/serve-sim"] as const;

const TARBALL_NAME = /^[A-Za-z0-9][A-Za-z0-9._-]*\.tgz$/;
const IMMUTABLE_CACHE_CONTROL = "public, max-age=31536000, immutable";
// Public objects are cached for an hour by default, which would keep workers on the old release.
const POINTER_CACHE_CONTROL = "no-cache, max-age=0";
const TARBALL_CONTENT_TYPE = "application/octet-stream";
const JSON_CONTENT_TYPE = "application/json";

/** The content of `<name>/latest.json` and `<name>/<version>.json`. */
export type MirrorPointer = {
  name: string;
  version: string;
  /** The tarball path relative to `<name>/`, in the npm registry layout. */
  tarball: string;
  /** npm's `dist.integrity` (sha512) of the tarball. */
  integrity: string;
  /** npm's `dist.shasum` (sha1) of the tarball. */
  shasum: string;
};

/** The `dist` fields of a version in the npm registry. */
export type NpmDist = { integrity: string; shasum: string; tarball: string };

export type MirrorUpload = {
  /** The generation the object must have; "0" means it must not exist yet. */
  ifGenerationMatch: string;
  cacheControl: string;
  contentType: string;
};

/** Object paths are relative to the mirror root, for example `expo-device-hub/latest.json`. */
export interface MirrorStorage {
  /** The object's generation, or undefined when it does not exist. */
  generationAsync(path: string): Promise<string | undefined>;
  readTextAsync(path: string): Promise<string>;
  uploadFileAsync(path: string, localPath: string, upload: MirrorUpload): Promise<void>;
  uploadTextAsync(path: string, text: string, upload: MirrorUpload): Promise<void>;
  /** Reads the object through its public URL, as EAS workers do. */
  fetchPublicAsync(path: string): Promise<Uint8Array>;
}

export type MirrorParts = { bucket: string; prefix: string; publicBaseUrl: string };

/** Parses `gs://<bucket>/<prefix>` and derives the public URL that EAS workers read. */
export function parseMirrorUrl(url: string): MirrorParts {
  const match = /^gs:\/\/([a-z0-9][a-z0-9._-]*)(?:\/(.*?))?\/*$/.exec(url.trim());
  if (!match) {
    throw new Error(`NPM_MIRROR_URL must look like gs://<bucket>/<prefix>, not "${url}".`);
  }
  const bucket = match[1]!;
  const prefix = match[2] ?? "";
  return {
    bucket,
    prefix,
    publicBaseUrl: `https://storage.googleapis.com/${bucket}${prefix ? `/${prefix}` : ""}`,
  };
}

export function sha512Integrity(bytes: Uint8Array): string {
  return `sha512-${createHash("sha512").update(bytes).digest("base64")}`;
}

/** The file name npm serves the tarball under, for example `serve-sim-0.14.3.tgz`. */
export function npmTarballName(dist: NpmDist): string {
  const name = new URL(dist.tarball).pathname.split("/").pop() ?? "";
  if (!TARBALL_NAME.test(name)) {
    throw new Error(`Unexpected npm tarball URL: ${dist.tarball}`);
  }
  return name;
}

export function isPrerelease(version: string): boolean {
  return version.includes("-");
}

function samePointer(a: MirrorPointer, b: MirrorPointer): boolean {
  return (
    a.name === b.name &&
    a.version === b.version &&
    a.tarball === b.tarball &&
    a.integrity === b.integrity &&
    a.shasum === b.shasum
  );
}

/**
 * Mirrors one release. The tarball must be the bytes that npm has: its sha512 must match npm's
 * `dist.integrity`. The pointer moves last, and only after the public tarball reads back with
 * that sha512. Every step can run again: a rerun skips what is already there and checks it.
 */
export async function mirrorReleaseAsync({
  name,
  version,
  tarball,
  npmDist,
  storage,
  log = console.log,
}: {
  name: string;
  version: string;
  /** The packed tarball and its local path. */
  tarball: { path: string; bytes: Uint8Array };
  npmDist: NpmDist;
  storage: MirrorStorage;
  log?: (message: string) => void;
}): Promise<{ pointerMoved: boolean }> {
  const integrity = sha512Integrity(tarball.bytes);
  if (integrity !== npmDist.integrity) {
    throw new Error(
      `The packed ${name}@${version} (${integrity}) is not the tarball on npm (${npmDist.integrity}). Nothing was uploaded.`,
    );
  }
  const tarballName = npmTarballName(npmDist);
  const tarballObject = `${name}/-/${tarballName}`;
  if ((await storage.generationAsync(tarballObject)) === undefined) {
    // Generation 0: a version is uploaded once and never replaced.
    await storage.uploadFileAsync(tarballObject, tarball.path, {
      ifGenerationMatch: "0",
      cacheControl: IMMUTABLE_CACHE_CONTROL,
      contentType: TARBALL_CONTENT_TYPE,
    });
    log(`- ${name}@${version}: uploaded ${tarballObject}`);
  } else {
    log(`- ${name}@${version}: ${tarballObject} exists`);
  }
  const publicIntegrity = sha512Integrity(await storage.fetchPublicAsync(tarballObject));
  if (publicIntegrity !== npmDist.integrity) {
    throw new Error(
      `The public ${tarballObject} (${publicIntegrity}) is not the tarball on npm (${npmDist.integrity}). latest.json was not changed.`,
    );
  }

  const pointer: MirrorPointer = {
    name,
    version,
    tarball: `-/${tarballName}`,
    integrity: npmDist.integrity,
    shasum: npmDist.shasum,
  };
  const pointerText = `${JSON.stringify(pointer, null, 2)}\n`;
  // The record of each version also makes a rollback one copy: `<version>.json` → `latest.json`.
  const versionObject = `${name}/${version}.json`;
  if ((await storage.generationAsync(versionObject)) === undefined) {
    await storage.uploadTextAsync(versionObject, pointerText, {
      ifGenerationMatch: "0",
      cacheControl: IMMUTABLE_CACHE_CONTROL,
      contentType: JSON_CONTENT_TYPE,
    });
  } else if (!samePointer(JSON.parse(await storage.readTextAsync(versionObject)), pointer)) {
    throw new Error(`${versionObject} exists with other content. latest.json was not changed.`);
  }

  const latestObject = `${name}/latest.json`;
  const latestGeneration = await storage.generationAsync(latestObject);
  if (latestGeneration !== undefined) {
    const current = JSON.parse(await storage.readTextAsync(latestObject)) as MirrorPointer;
    if (Bun.semver.order(current.version, version) >= 0) {
      log(`- ${name}@${version}: latest.json stays at ${current.version}`);
      return { pointerMoved: false };
    }
  }
  // One object write is atomic, and the generation check stops a parallel release from being
  // overwritten by an older one.
  await storage.uploadTextAsync(latestObject, pointerText, {
    ifGenerationMatch: latestGeneration ?? "0",
    cacheControl: POINTER_CACHE_CONTROL,
    contentType: JSON_CONTENT_TYPE,
  });
  log(`- ${name}@${version}: latest.json now points to ${version}`);
  return { pointerMoved: true };
}
