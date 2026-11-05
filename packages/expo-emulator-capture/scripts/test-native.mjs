import { mkdir } from "node:fs/promises";
import { join } from "node:path";
import { $, root } from "./common.mjs";

// The protocol helpers are portable C++, so these checks run on any host,
// including the Linux CI image.
const compiler = process.env.CXX || "c++";
await mkdir(join(root, "build"), { recursive: true });
for (const test of ["protocol"]) {
  await $`${compiler} -std=c++17 -O2 -Wall -Wextra tests/${test}.test.cpp -o build/${test}-test`;
  await $`./build/${test}-test`;
}
