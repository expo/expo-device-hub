import { mkdir } from "node:fs/promises";
import { join } from "node:path";
import { $, root } from "./common.mjs";

// The protocol, color conversion and rotation helpers are portable C++, so these
// checks run on any host, including the Linux CI image.
const compiler = process.env.CXX || "c++";
await mkdir(join(root, "build"), { recursive: true });
for (const test of [
  "protocol",
  "safety",
  "encoder-wake",
  "yuv",
  "lag-tail",
  "nvidia-transform",
  "nvidia-probe",
]) {
  await $`${compiler} -std=c++17 -O2 -Wall -Wextra -pthread tests/${test}.test.cpp -o build/${test}-test`;
  await $`./build/${test}-test`;
}

await $`${compiler} -std=c++17 -O2 -Wall -Wextra -I tests/fixtures/gum tests/gfxstream-startup.test.cpp src/native/gfxstream.cpp -o build/gfxstream-startup-test`;
await $`./build/gfxstream-startup-test`;
await $`${compiler} -std=c++17 -O2 -Wall -Wextra -DEXPO_EMULATOR_CAPTURE_NVIDIA -I tests/fixtures/gum tests/gfxstream-startup.test.cpp src/native/gfxstream.cpp -o build/nvidia-startup-test`;
await $`./build/nvidia-startup-test`;

// Includes the real post/queue implementation with a fake source and Gum
// declarations; no CUDA, NVENC, renderer or device is loaded.
await $`${compiler} -std=c++17 -O2 -Wall -Wextra -pthread -fno-access-control -DEXPO_EMULATOR_CAPTURE_NVIDIA -I tests/fixtures/agent-gum tests/agent-tail.test.cpp -o build/agent-tail-test`;
await $`./build/agent-tail-test`;

if (process.platform === "darwin" && process.arch === "arm64") {
  for (const test of ["videotoolbox", "videotoolbox-letterbox"]) {
    await $`clang++ -std=c++17 -fobjc-arc -O2 -Wall -Wextra tests/${test}.test.mm src/native/encoder-videotoolbox.mm -framework Foundation -framework CoreFoundation -framework CoreMedia -framework CoreVideo -framework IOSurface -framework VideoToolbox -o build/${test}-test`;
    await $`./build/${test}-test`;
  }
}
