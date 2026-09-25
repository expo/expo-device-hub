import { access, mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { constants } from "node:fs";
import { join } from "node:path";
import { $, root } from "./common.mjs";
import { unlessLinux64 } from "./platform.mjs";
import { summarize } from "./summarize.mjs";

unlessLinux64("benchmark");

const args = process.argv.slice(2);
const [pid, rate = "60", seconds = "30"] = args;
const fps = Number(rate);
const durationSeconds = Number(seconds);
const validPid = /^[1-9][0-9]{0,9}$/.test(pid ?? "");
const validFps = /^[1-9][0-9]{0,2}$/.test(rate) && fps <= 120;
const validDuration = /^[1-9][0-9]{0,3}$/.test(seconds) && durationSeconds <= 3600;
if (args.length > 3 || !validPid || !validFps || !validDuration)
  throw new Error("Usage: npm run benchmark -- PID [FPS=60 (1–120)] [SECONDS=30 (1–3600)]");

// Check the injector and target before creating a new benchmark directory.
const injectorPath = join(root, "dist/linux-x64/inject");
await access(injectorPath, constants.X_OK);
process.kill(Number(pid), 0);

const benchmarksDirectory = join(root, "artifacts/benchmarks");
await mkdir(benchmarksDirectory, { recursive: true });
const outputDirectory = await mkdtemp(join(benchmarksDirectory, "run-"));
const baselineLogPath = join(outputDirectory, "baseline.log");
const captureLogPath = join(outputDirectory, "capture.log");
const videoPath = join(outputDirectory, "capture.h264");
const metricsPath = join(outputDirectory, "capture.h264.csv");
const summaryPath = join(outputDirectory, "summary.json");
console.log(`Benchmark output: ${outputDirectory}`);

// A baseline may precede the first capture without restarting the emulator.
const baselineArgs = ["run", "--silent", "capture", "--", pid, "--count-posts", "--seconds", "10"];
await $`${process.execPath} ${baselineArgs} &> ${baselineLogPath}`;
process.stdout.write(await readFile(baselineLogPath));

// Stop at the requested frame count, allowing five extra seconds to reach it.
const frameCount = fps * durationSeconds;
const captureTimeoutSeconds = durationSeconds + 5;
const captureArgs = [
  "run", "--silent", "capture", "--", pid, "--fps", rate,
  "--frames", String(frameCount), "--seconds", String(captureTimeoutSeconds),
  "--output", videoPath,
];
await $`${process.execPath} ${captureArgs} &> ${captureLogPath}`;
process.stdout.write(await readFile(captureLogPath));

const metricsCsv = await readFile(metricsPath, "utf8");
const summary = summarize(metricsCsv, metricsPath);
const summaryJson = JSON.stringify(summary, null, 2);
await writeFile(summaryPath, `${summaryJson}\n`);
console.log(summaryJson);
