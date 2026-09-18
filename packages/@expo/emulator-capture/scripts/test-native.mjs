import { mkdir } from "node:fs/promises";
import { join } from "node:path";
import { $ } from "./common.mjs";
import { paths } from "./build-paths.mjs";
import { unlessLinux64 } from "./platform.mjs";

unlessLinux64("test:native");

const buildDirectory = paths.buildDirectory;
const testSourcePath = "tests/stream-format.test.cpp";
const testBinaryPath = join(buildDirectory, "stream-format-test");

await mkdir(buildDirectory, { recursive: true });
await $`clang++ -std=c++17 ${testSourcePath} -o ${testBinaryPath}`;
await $`${testBinaryPath}`;
