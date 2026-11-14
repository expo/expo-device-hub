import { mkdir } from "node:fs/promises";
import { join } from "node:path";
import { $, root } from "./common.mjs";

// The protocol, color conversion and rotation helpers are portable C++, so these
// checks run on any host, including the Linux CI image.
const compiler = process.env.CXX || "c++";
await mkdir(join(root, "build"), { recursive: true });
for (const test of ["protocol", "safety", "encoder-wake", "yuv", "lag-tail"]) {
  await $`${compiler} -std=c++17 -O2 -Wall -Wextra -pthread tests/${test}.test.cpp -o build/${test}-test`;
  await $`./build/${test}-test`;
}

await $`${compiler} -std=c++17 -O2 -Wall -Wextra -I tests/fixtures/gum tests/gfxstream-startup.test.cpp src/native/gfxstream.cpp -o build/gfxstream-startup-test`;
await $`./build/gfxstream-startup-test`;

if (process.platform === "linux") {
  await $`${compiler} -std=c++17 -O2 -Wall -Wextra -pthread tests/pbo-readback.test.cpp -o build/pbo-readback-test`;
  await $`./build/pbo-readback-test`;
}

if (process.platform === "darwin" && process.arch === "arm64") {
  await $`clang++ -std=c++17 -fobjc-arc -O2 -Wall -Wextra tests/videotoolbox.test.mm src/native/encoder-videotoolbox.mm -framework Foundation -framework CoreFoundation -framework CoreMedia -framework CoreVideo -framework IOSurface -framework VideoToolbox -o build/videotoolbox-test`;
  await $`./build/videotoolbox-test`;
}
