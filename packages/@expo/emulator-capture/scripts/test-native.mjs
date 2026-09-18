import { mkdir } from "node:fs/promises";
import { join } from "node:path";
import { $, root } from "./common.mjs";
import { unlessLinux64 } from "./platform.mjs";

unlessLinux64("test:native");

const buildDirectory = join(root, "build");
const testSourcePath = "tests/stream-format.test.cpp";
const testBinaryPath = "build/stream-format-test";

await mkdir(buildDirectory, { recursive: true });
await $`clang++ -std=c++17 ${testSourcePath} -o ${testBinaryPath}`;
await $`./${testBinaryPath}`;
