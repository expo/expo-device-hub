import { skipUnlessNative } from "./platform.mjs";

import { mkdir } from "node:fs/promises";
import { join } from "node:path";
import { $, root } from "./common.mjs";

skipUnlessNative("test:native");

await mkdir(join(root, "build"), { recursive: true });
await $`clang++ -std=c++17 tests/stream-format.test.cpp -o build/stream-format-test`;
await $`./build/stream-format-test`;
