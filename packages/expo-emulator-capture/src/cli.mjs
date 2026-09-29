#!/usr/bin/env node
// No Node addon: launch the native helper and inherit its status output.
import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { fileURLToPath } from "node:url";

if (process.platform !== "linux" || process.arch !== "x64") {
  console.error("[emulator-capture] Capture requires Linux x64 (with NVIDIA GPU).");
  process.exit(1);
}
const binary = fileURLToPath(new URL("../dist/linux-x64/inject", import.meta.url));
if (!existsSync(binary)) {
  console.error("[emulator-capture] Native binary missing. Run npm run build in this package on Linux x64 first.");
  process.exit(1);
}
const args = process.argv.slice(2);
const child = spawn(binary, args, { stdio: "inherit" });
for (const signal of ["SIGINT", "SIGTERM"])
  process.on(signal, () => { if (child.exitCode === null) child.kill(signal); });
child.on("error", error => { console.error(error.message); process.exitCode = 1; });
child.on("exit", (code, signal) => { process.exitCode = code ?? (signal === "SIGINT" ? 130 : 1); });
