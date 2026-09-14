import { skipUnlessNative } from "./platform.mjs";

// Build-time NVRTC only. The injected library still uses the existing CUDA driver.
import { existsSync } from "node:fs";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

skipUnlessNative("build:scale");

const root = fileURLToPath(new URL("../", import.meta.url));
const library = resolve(root, process.env.POC_NVRTC_LIBRARY || "deps/nvrtc/lib/libnvrtc.so.12");
if (!existsSync(library))
  throw new Error("Run npm run setup:build or set POC_NVRTC_LIBRARY to an absolute NVRTC library path");

// The loader reads this path at process startup. Restart only this compiler
// with NVRTC's companion library directory; capture never inherits the change.
// execve replaces this process, avoiding a second Bun process during compilation.
const libraryDirectory = dirname(library);
if (!(process.env.LD_LIBRARY_PATH || "").split(":").includes(libraryDirectory)) {
  process.execve(process.execPath, [process.execPath, fileURLToPath(import.meta.url)], {
    ...process.env,
    LD_LIBRARY_PATH: [libraryDirectory, process.env.LD_LIBRARY_PATH].filter(Boolean).join(":"),
  });
}
const { dlopen, ptr, read } = await import("bun:ffi");

// Linux x64: nvrtcProgram and size_t are both 64-bit. Keep the JS buffers alive
// while NVRTC reads them; pointer values alone do not retain their backing memory.
const source = Buffer.from(`${await readFile(join(root, "src/scale.cu"), "utf8")}\0`);
const name = Buffer.from("scale.cu\0");
const optionBuffers = ["--gpu-architecture=compute_75", "--std=c++11"].map(value => Buffer.from(`${value}\0`));
const options = BigUint64Array.from(optionBuffers.map(value => BigInt(ptr(value))));
const program = new BigUint64Array(1);
const size = new BigUint64Array(1);
const api = dlopen(library, {
  nvrtcCreateProgram: { args: ["ptr", "ptr", "ptr", "i32", "ptr", "ptr"], returns: "i32" },
  nvrtcCompileProgram: { args: ["ptr", "i32", "ptr"], returns: "i32" },
  nvrtcGetProgramLogSize: { args: ["ptr", "ptr"], returns: "i32" },
  nvrtcGetProgramLog: { args: ["ptr", "ptr"], returns: "i32" },
  nvrtcGetPTXSize: { args: ["ptr", "ptr"], returns: "i32" },
  nvrtcGetPTX: { args: ["ptr", "ptr"], returns: "i32" },
  nvrtcDestroyProgram: { args: ["ptr"], returns: "i32" },
  nvrtcGetErrorString: { args: ["i32"], returns: "cstring" },
});
const nvrtc = api.symbols;
function check(code) {
  if (code !== 0) throw new Error(`NVRTC error ${code}: ${nvrtc.nvrtcGetErrorString(code)}`);
}
function resultBuffer() {
  const length = Number(size[0]);
  if (!Number.isSafeInteger(length) || length < 1)
    throw new Error(`Invalid NVRTC output size: ${size[0]}`);
  return Buffer.alloc(length);
}
try {
  check(nvrtc.nvrtcCreateProgram(ptr(program), ptr(source), ptr(name), 0, null, null));
  const handle = read.ptr(ptr(program), 0);
  const result = nvrtc.nvrtcCompileProgram(handle, optionBuffers.length, ptr(options));
  // Referencing the buffers after the native call also keeps their storage live.
  for (const buffer of [source, name, ...optionBuffers]) void buffer.byteLength;
  check(nvrtc.nvrtcGetProgramLogSize(handle, ptr(size)));
  const log = resultBuffer();
  check(nvrtc.nvrtcGetProgramLog(handle, ptr(log)));
  if (log[0] !== 0) process.stderr.write(log.subarray(0, -1));
  check(result);
  check(nvrtc.nvrtcGetPTXSize(handle, ptr(size)));
  const ptx = resultBuffer();
  check(nvrtc.nvrtcGetPTX(handle, ptr(ptx)));
  await mkdir(join(root, "build"), { recursive: true });
  await writeFile(join(root, "build/scale-ptx.h"),
    `static const char scalePtx[] = R"PTX(${ptx.subarray(0, -1).toString()})PTX";\n`);
  console.log("Generated build/scale-ptx.h with NVRTC");
} finally {
  try {
    if (program[0] !== 0n) check(nvrtc.nvrtcDestroyProgram(ptr(program)));
  } finally {
    api.close();
  }
}
