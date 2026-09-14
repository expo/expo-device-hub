import { skipUnlessNative } from "./platform.mjs";

import { access, mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { constants } from "node:fs";
import { join } from "node:path";
import { $, root } from "./common.mjs";
import { summarize } from "./summarize.mjs";

skipUnlessNative("benchmark");

const args = process.argv.slice(2);
const [pid, rate = "60", seconds = "30"] = args;
if (args.length > 3 || !/^[1-9][0-9]{0,9}$/.test(pid ?? "") ||
    !/^[1-9][0-9]{0,2}$/.test(rate) || !/^[1-9][0-9]{0,3}$/.test(seconds) ||
    Number(rate) > 120 || Number(seconds) > 3600)
  throw new Error("Usage: npm run benchmark -- PID [FPS=60 (1–120)] [SECONDS=30 (1–3600)]");
await access(join(root, "dist/linux-x64/inject"), constants.X_OK);
process.kill(Number(pid), 0);
const directory = join(root, "artifacts/benchmarks");
await mkdir(directory, { recursive: true });
const output = await mkdtemp(join(directory, "run-"));
console.log(`Benchmark output: ${output}`);
// A baseline may precede the first capture without restarting the emulator.
const baselineArgs = ["run", "--silent", "capture", "--", pid, "--count-posts", "--seconds", "10"];
await $`${process.execPath} ${baselineArgs} &> ${join(output, "baseline.log")}`;
process.stdout.write(await readFile(join(output, "baseline.log")));
const captureArgs = [
  "run", "--silent", "capture", "--", pid, "--fps", rate,
  "--frames", String(Number(rate) * Number(seconds)), "--seconds", String(Number(seconds) + 5),
  "--output", join(output, "capture.h264"),
];
await $`${process.execPath} ${captureArgs} &> ${join(output, "capture.log")}`;
process.stdout.write(await readFile(join(output, "capture.log")));
const csv = join(output, "capture.h264.csv");
const summary = JSON.stringify(summarize(await readFile(csv, "utf8"), csv), null, 2);
await writeFile(join(output, "summary.json"), `${summary}\n`);
console.log(summary);
