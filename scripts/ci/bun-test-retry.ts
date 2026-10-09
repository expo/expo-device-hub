#!/usr/bin/env bun
// Runs `bun test`, then reruns only the files with failed tests once.
//
//   bun scripts/ci/bun-test-retry.ts [--before-retry=<script>] -- <bun test args>
//   bun scripts/ci/bun-test-retry.ts --workspaces
//
// Failed files come from Bun's JUnit report. A failure that the report does
// not attribute to a file (for example an error between tests) is not
// retried, and neither is an attempt that times out. Pass `bun test` flags in `--flag=value` form: the retry keeps the
// flags and replaces the paths with the failed files.

import { Glob, type Subprocess } from "bun";
import { mkdtemp } from "node:fs/promises";
import { constants, tmpdir } from "node:os";
import { join } from "node:path";

const ATTEMPT_TIMEOUT_MS = 20 * 60_000;
// Exit code for a killed attempt, as with timeout(1).
const TIMED_OUT = 124;

// Workspaces run in parallel, so forward cancellation to every running child.
const running = new Set<Subprocess>();
for (const signal of ["SIGINT", "SIGTERM", "SIGHUP"] as const) {
  process.on(signal, () => {
    for (const child of running) child.kill(signal);
    process.exit(128 + constants.signals[signal]);
  });
}

interface Options {
  cwd?: string;
  beforeRetry?: string;
  timeoutMs?: number;
}

async function run(cmd: string[], { cwd, timeoutMs = ATTEMPT_TIMEOUT_MS }: Options): Promise<number> {
  const child = Bun.spawn(cmd, { cwd, stdio: ["ignore", "inherit", "inherit"] });
  running.add(child);
  let timedOut = false;
  const timer = setTimeout(() => {
    timedOut = true;
    console.error(`::error::${cmd.join(" ")} ran for ${timeoutMs / 60_000} minutes; killing it`);
    if (process.platform === "darwin") Bun.spawnSync(["sample", String(child.pid), "3", "-mayDie"]);
    child.kill("SIGKILL");
  }, timeoutMs);
  const code = await child.exited;
  clearTimeout(timer);
  running.delete(child);
  return timedOut ? TIMED_OUT : code;
}

async function failedFiles(report: string): Promise<string[]> {
  const failed = new Set<string>();
  if (!(await Bun.file(report).exists())) return [];
  await new HTMLRewriter()
    .on("testsuite[file]", {
      element(suite) {
        if (suite.getAttribute("failures") !== "0") failed.add(suite.getAttribute("file")!);
      },
    })
    .transform(new Response(Bun.file(report)))
    .text();
  return [...failed];
}

export async function testWithRetry(args: string[], options: Options = {}): Promise<number> {
  const reports = await mkdtemp(join(tmpdir(), "bun-test-retry-"));
  const report = join(reports, "initial.xml");
  const junit = (file: string) => ["--reporter=junit", `--reporter-outfile=${file}`];

  const code = await run(["bun", "test", ...junit(report), ...args], options);
  if (code === 0) return 0;
  // A partial report would hide the test that hung.
  if (code === TIMED_OUT) return code;

  const files = await failedFiles(report);
  if (files.length === 0) {
    console.error("::error::bun test failed outside a test file; not retrying");
    return code;
  }
  console.log(`Retrying ${files.length} failed file(s): ${files.join(" ")}`);
  if (options.beforeRetry && (await run(["bash", options.beforeRetry], options)) !== 0) return code;

  const flags = args.filter((arg) => arg.startsWith("-"));
  const paths = files.map((file) => `./${file}`);
  return run(["bun", "test", ...junit(join(reports, "retry.xml")), ...flags, ...paths], options);
}

async function testWorkspaces(): Promise<number> {
  const root = process.cwd();
  const patterns: string[] = (await Bun.file("package.json").json()).workspaces.packages;
  const dirs: string[] = [];
  for (const pattern of patterns) {
    for await (const manifest of new Glob(`${pattern}/package.json`).scan(root)) {
      if ((await Bun.file(manifest).json()).scripts?.test === "bun test") {
        dirs.push(join(root, manifest, ".."));
      }
    }
  }
  const codes = await Promise.all(dirs.map((cwd) => testWithRetry([], { cwd })));
  return codes.some((code) => code !== 0) ? 1 : 0;
}

if (import.meta.main) {
  const argv = process.argv.slice(2);
  if (argv[0] === "--workspaces") {
    process.exit(await testWorkspaces());
  }
  const separator = argv.indexOf("--");
  const options = separator === -1 ? argv : argv.slice(0, separator);
  const beforeRetry = options.find((o) => o.startsWith("--before-retry="))?.split("=")[1];
  process.exit(await testWithRetry(separator === -1 ? [] : argv.slice(separator + 1), { beforeRetry }));
}
