// Build-time NVRTC only. The injected library still uses the existing CUDA driver.
import { existsSync } from "node:fs";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { unlessLinux64 } from "./platform.mjs";

unlessLinux64("build:scale");

const root = fileURLToPath(new URL("../", import.meta.url));
const nvrtcLibraryPath = resolve(root, process.env.POC_NVRTC_LIBRARY || "deps/nvrtc/lib/libnvrtc.so.12");
if (!existsSync(nvrtcLibraryPath))
  throw new Error("Run npm run setup:build or set POC_NVRTC_LIBRARY to an absolute NVRTC library path");

// The loader reads this path at process startup. Restart only this compiler
// with NVRTC's companion library directory; capture never inherits the change.
// execve replaces this process, avoiding a second Bun process during compilation.
const libraryDirectory = dirname(nvrtcLibraryPath);
const existingLibraryPath = process.env.LD_LIBRARY_PATH || "";
if (!existingLibraryPath.split(":").includes(libraryDirectory)) {
  const scriptPath = fileURLToPath(import.meta.url);
  const compilerEnvironment = {
    ...process.env,
    LD_LIBRARY_PATH: [libraryDirectory, process.env.LD_LIBRARY_PATH].filter(Boolean).join(":"),
  };
  process.execve(process.execPath, [process.execPath, scriptPath], compilerEnvironment);
}
const { dlopen, ptr, read } = await import("bun:ffi");

// Prepare null-terminated C strings and an array of pointers for NVRTC.
const sourcePath = join(root, "src/scale.cu");
const sourceBuffer = Buffer.from(`${await readFile(sourcePath, "utf8")}\0`);
const sourceNameBuffer = Buffer.from("scale.cu\0");
const compileOptions = ["--gpu-architecture=compute_75", "--std=c++11"];
const optionBuffers = compileOptions.map(value => Buffer.from(`${value}\0`));
const optionPointers = BigUint64Array.from(optionBuffers.map(value => BigInt(ptr(value))));

// Linux x64: NVRTC writes a 64-bit program handle and output sizes into these buffers.
const programHandleBuffer = new BigUint64Array(1);
const outputSizeBuffer = new BigUint64Array(1);
const nvrtcLibrary = dlopen(nvrtcLibraryPath, {
  nvrtcCreateProgram: { args: ["ptr", "ptr", "ptr", "i32", "ptr", "ptr"], returns: "i32" },
  nvrtcCompileProgram: { args: ["ptr", "i32", "ptr"], returns: "i32" },
  nvrtcGetProgramLogSize: { args: ["ptr", "ptr"], returns: "i32" },
  nvrtcGetProgramLog: { args: ["ptr", "ptr"], returns: "i32" },
  nvrtcGetPTXSize: { args: ["ptr", "ptr"], returns: "i32" },
  nvrtcGetPTX: { args: ["ptr", "ptr"], returns: "i32" },
  nvrtcDestroyProgram: { args: ["ptr"], returns: "i32" },
  nvrtcGetErrorString: { args: ["i32"], returns: "cstring" },
});
const nvrtc = nvrtcLibrary.symbols;

function check(code) {
  if (code !== 0) throw new Error(`NVRTC error ${code}: ${nvrtc.nvrtcGetErrorString(code)}`);
}

function allocateOutputBuffer() {
  const byteLength = Number(outputSizeBuffer[0]);
  if (!Number.isSafeInteger(byteLength) || byteLength < 1)
    throw new Error(`Invalid NVRTC output size: ${outputSizeBuffer[0]}`);
  return Buffer.alloc(byteLength);
}

try {
  check(nvrtc.nvrtcCreateProgram(ptr(programHandleBuffer), ptr(sourceBuffer), ptr(sourceNameBuffer), 0, null, null));
  const programHandle = read.ptr(ptr(programHandleBuffer), 0);
  const compileResult = nvrtc.nvrtcCompileProgram(programHandle, optionBuffers.length, ptr(optionPointers));

  // Referencing the buffers after the native call keeps their backing memory alive.
  for (const buffer of [sourceBuffer, sourceNameBuffer, ...optionBuffers]) void buffer.byteLength;

  // Print the compiler diagnostics before reporting a compilation failure.
  check(nvrtc.nvrtcGetProgramLogSize(programHandle, ptr(outputSizeBuffer)));
  const compilerLog = allocateOutputBuffer();
  check(nvrtc.nvrtcGetProgramLog(programHandle, ptr(compilerLog)));
  if (compilerLog[0] !== 0) process.stderr.write(compilerLog.subarray(0, -1));
  check(compileResult);

  // Embed the PTX as a C++ string, omitting NVRTC's trailing null byte.
  check(nvrtc.nvrtcGetPTXSize(programHandle, ptr(outputSizeBuffer)));
  const ptxBuffer = allocateOutputBuffer();
  check(nvrtc.nvrtcGetPTX(programHandle, ptr(ptxBuffer)));
  const buildDirectory = join(root, "build");
  const headerPath = join(root, "build/scale-ptx.h");
  await mkdir(buildDirectory, { recursive: true });
  const ptxSource = ptxBuffer.subarray(0, -1).toString();
  const headerSource = `static const char scalePtx[] = R"PTX(${ptxSource})PTX";\n`;
  await writeFile(headerPath, headerSource);
  console.log("Generated build/scale-ptx.h with NVRTC");
} finally {
  try {
    if (programHandleBuffer[0] !== 0n) check(nvrtc.nvrtcDestroyProgram(ptr(programHandleBuffer)));
  } finally {
    nvrtcLibrary.close();
  }
}
