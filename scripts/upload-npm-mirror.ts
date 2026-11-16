#!/usr/bin/env bun

// Copies the released tarballs of the packages that EAS device sessions run into the npm mirror
// (NPM_MIRROR_URL, for example gs://turtle-v2/npm) and moves their `latest.json` pointers. The
// release workflow runs it after `changeset publish`, with Google Cloud credentials.
//
//   ./scripts/upload-npm-mirror.ts                  mirror the packages this release published
//   ./scripts/upload-npm-mirror.ts expo-device-hub@0.24.0
//                                                   mirror a version from npm (backfill, recovery)
//
// NPM_MIRROR_PREDEFINED_ACL (optional) is passed to `gcloud storage cp --predefined-acl`, for a
// bucket with fine-grained ACLs where each object must be made public. NPM_MIRROR_PUBLIC_URL
// (optional) replaces the public URL derived from NPM_MIRROR_URL, where the copies are read back.

import { $ } from "bun";
import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  MIRRORED_PACKAGES,
  type MirrorStorage,
  type NpmDist,
  isPrerelease,
  mirrorReleaseAsync,
  parseMirrorUrl,
} from "./lib/npm-mirror.ts";
import { getPublicPackages } from "./lib/public-packages.ts";

// npm can list a new version a little after `npm publish` returns.
const NPM_VIEW_ATTEMPTS = 20;
const NPM_VIEW_DELAY_MS = 15_000;
const PUBLIC_READ_ATTEMPTS = 3;

const mirrorUrl = process.env.NPM_MIRROR_URL;
if (!mirrorUrl) {
  console.log("::error::NPM_MIRROR_URL is not set.");
  process.exit(1);
}
const mirror = parseMirrorUrl(mirrorUrl);
const { bucket, prefix } = mirror;
const publicBaseUrl = (process.env.NPM_MIRROR_PUBLIC_URL || mirror.publicBaseUrl).replace(
  /\/+$/,
  "",
);
const predefinedAcl = process.env.NPM_MIRROR_PREDEFINED_ACL || undefined;
const workDir = await mkdtemp(join(tmpdir(), "npm-mirror-"));

function gsUrl(path: string): string {
  return `gs://${bucket}/${prefix ? `${prefix}/` : ""}${path}`;
}

const storage: MirrorStorage = {
  async generationAsync(path) {
    const result =
      await $`gcloud storage objects describe ${gsUrl(path)} ${"--format=value(generation)"}`
        .nothrow()
        .quiet();
    if (result.exitCode === 0) {
      return result.stdout.toString().trim();
    }
    const stderr = result.stderr.toString();
    if (/not ?found|404/i.test(stderr)) {
      return undefined;
    }
    throw new Error(`Could not read ${gsUrl(path)}: ${stderr.trim()}`);
  },
  async readTextAsync(path) {
    return await $`gcloud storage cat ${gsUrl(path)}`.quiet().text();
  },
  async uploadFileAsync(path, localPath, { ifGenerationMatch, cacheControl, contentType }) {
    const acl = predefinedAcl ? [`--predefined-acl=${predefinedAcl}`] : [];
    await $`gcloud storage cp ${localPath} ${gsUrl(path)} --if-generation-match=${ifGenerationMatch} --cache-control=${cacheControl} --content-type=${contentType} ${acl}`;
  },
  async uploadTextAsync(path, text, upload) {
    const localPath = join(workDir, `${crypto.randomUUID()}.json`);
    await writeFile(localPath, text);
    await storage.uploadFileAsync(path, localPath, upload);
  },
  async fetchPublicAsync(path) {
    const url = `${publicBaseUrl}/${path}`;
    let lastError: unknown;
    for (let attempt = 1; attempt <= PUBLIC_READ_ATTEMPTS; attempt++) {
      try {
        const response = await fetch(url, { headers: { "cache-control": "no-cache" } });
        if (response.ok) return new Uint8Array(await response.arrayBuffer());
        lastError = new Error(`GET ${url} returned ${response.status}`);
      } catch (error) {
        lastError = error;
      }
      await Bun.sleep(2_000 * attempt);
    }
    throw lastError;
  },
};

async function readNpmDistAsync(name: string, version: string): Promise<NpmDist> {
  let lastError = "";
  for (let attempt = 1; attempt <= NPM_VIEW_ATTEMPTS; attempt++) {
    const result =
      await $`npm view ${`${name}@${version}`} dist --json --prefer-online --fetch-retries=0`
        .nothrow()
        .quiet();
    const output = result.stdout.toString().trim();
    if (result.exitCode === 0 && output) {
      const dist = JSON.parse(output) as Partial<NpmDist>;
      if (dist.integrity && dist.shasum && dist.tarball) {
        return { integrity: dist.integrity, shasum: dist.shasum, tarball: dist.tarball };
      }
    }
    lastError = result.stderr.toString().trim() || `no dist for ${name}@${version}`;
    console.log(`  npm does not list ${name}@${version} yet (attempt ${attempt}): ${lastError}`);
    await Bun.sleep(NPM_VIEW_DELAY_MS);
  }
  throw new Error(`npm does not list ${name}@${version}: ${lastError}`);
}

type PackedTarball = { name: string; version: string; path: string };

async function packAsync(cwd: string, spec: string[]): Promise<PackedTarball> {
  const [packed] = JSON.parse(
    await $`npm pack ${spec} --pack-destination ${workDir} --json`.cwd(cwd).text(),
  ) as { name: string; version: string; filename: string }[];
  if (!packed) throw new Error(`npm pack ${spec.join(" ")} produced no tarball.`);
  return { name: packed.name, version: packed.version, path: join(workDir, packed.filename) };
}

async function tagIsHeadAsync(tag: string): Promise<boolean> {
  const tagged = await $`git rev-list -n 1 ${`refs/tags/${tag}`}`.nothrow().quiet();
  if (tagged.exitCode !== 0) return false;
  const head = await $`git rev-parse HEAD`.quiet().text();
  return tagged.stdout.toString().trim() === head.trim();
}

/** The mirrored packages that `changeset publish` tagged on this commit. */
async function packReleasedAsync(): Promise<PackedTarball[]> {
  const packed: PackedTarball[] = [];
  for (const pkg of await getPublicPackages()) {
    if (!(MIRRORED_PACKAGES as readonly string[]).includes(pkg.name)) continue;
    const tag = `${pkg.name}@${pkg.version}`;
    if (isPrerelease(pkg.version)) {
      console.log(`- ${tag}: a prerelease is not \`latest\` on npm — skipping`);
      continue;
    }
    // An older tag means that this release did not publish the package.
    if (!(await tagIsHeadAsync(tag))) {
      console.log(`- ${tag}: not published by this release — skipping`);
      continue;
    }
    // create-github-releases.ts packs the same way; the bytes match npm's `dist.integrity`.
    packed.push(await packAsync(pkg.dir, []));
  }
  return packed;
}

/** Downloads the given versions from npm; `npm pack` checks them against `dist.integrity`. */
async function packFromNpmAsync(specs: string[]): Promise<PackedTarball[]> {
  const packed: PackedTarball[] = [];
  for (const spec of specs) {
    const tarball = await packAsync(workDir, [spec]);
    if (!(MIRRORED_PACKAGES as readonly string[]).includes(tarball.name)) {
      throw new Error(`${tarball.name} is not one of ${MIRRORED_PACKAGES.join(", ")}.`);
    }
    if (isPrerelease(tarball.version)) {
      throw new Error(`${tarball.name}@${tarball.version} is a prerelease.`);
    }
    packed.push(tarball);
  }
  return packed;
}

const specs = process.argv.slice(2);
const tarballs = specs.length > 0 ? await packFromNpmAsync(specs) : await packReleasedAsync();
if (tarballs.length === 0) {
  console.log("No mirrored package was published by this release.");
}
for (const tarball of tarballs) {
  await mirrorReleaseAsync({
    name: tarball.name,
    version: tarball.version,
    tarball: { path: tarball.path, bytes: new Uint8Array(await readFile(tarball.path)) },
    npmDist: await readNpmDistAsync(tarball.name, tarball.version),
    storage,
  });
}
