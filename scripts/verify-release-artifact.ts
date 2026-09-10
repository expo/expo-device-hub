#!/usr/bin/env bun
import { verifyReleaseArtifact } from "./lib/release-artifact.ts";

const tarball = process.argv[2];
if (!tarball) throw new Error("Usage: bun scripts/verify-release-artifact.ts <tarball>");
const { version } = await Bun.file("packages/expo-device-hub/package.json").json();
verifyReleaseArtifact(tarball, version);
console.log(`Verified ${tarball} for expo-device-hub@${version}`);
