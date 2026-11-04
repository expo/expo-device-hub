import { mkdir } from "node:fs/promises";
import { join } from "node:path";
import { $, root } from "./common.mjs";

// The protocol helpers are portable C++, so these checks run on any host,
// including the Linux CI image.
const compiler = process.env.CXX || "c++";
await mkdir(join(root, "build"), { recursive: true });
await $`${compiler} -std=c++17 -Wall -Wextra tests/protocol.test.cpp -o build/protocol-test`;
await $`./build/protocol-test`;
