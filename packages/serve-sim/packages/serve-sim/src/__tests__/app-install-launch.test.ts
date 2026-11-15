import { afterAll, afterEach, beforeAll, beforeEach, expect, spyOn, test } from "bun:test";
import { chmod, mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { APP_NOT_OPENED } from "../app-install-format";
import { InvalidHostActionError, runHostActionAsync } from "../host-actions";
import { UPLOAD_DIR } from "../host-paths";
import { readLaunchState } from "../launch-state";
import { UDID, installShims, useTempStateDir } from "./helpers";

const BIN = fileURLToPath(new URL("../../dist/serve-sim.js", import.meta.url));
let root: string;
let log: string;
let shims: ReturnType<typeof installShims>;
let state: ReturnType<typeof useTempStateDir>;

beforeAll(async () => {
  await mkdir(UPLOAD_DIR, { recursive: true });
  root = await mkdtemp(join(UPLOAD_DIR, "install-launch-test-"));
  log = join(root, "xcrun.jsonl");
  // Records every simctl call; SERVE_SIM_FAIL_VERB makes that verb fail.
  shims = installShims({
    xcrun: `#!/usr/bin/env node
require("fs").appendFileSync(${JSON.stringify(log)}, JSON.stringify(process.argv.slice(2)) + "\\n");
if (process.argv[3] === process.env.SERVE_SIM_FAIL_VERB) {
  process.stderr.write("simctl " + process.argv[3] + " failed\\n");
  process.exit(4);
}
`,
  });
});
afterAll(async () => {
  shims.restore();
  await rm(root, { recursive: true, force: true });
});
beforeEach(() => {
  writeFileSync(log, "");
  state = useTempStateDir();
});
afterEach(() => {
  delete process.env.SERVE_SIM_FAIL_VERB;
  state.restore();
});

async function app(name: string, bundleId?: string) {
  const path = join(root, name);
  await mkdir(path, { recursive: true });
  const key =
    bundleId === undefined ? "" : `<key>CFBundleIdentifier</key><string>${bundleId}</string>`;
  await writeFile(
    join(path, "Info.plist"),
    `<?xml version="1.0" encoding="UTF-8"?><plist version="1.0"><dict>${key}</dict></plist>`,
  );
  await writeFile(join(path, "App"), "executable");
  await chmod(join(path, "App"), 0o755);
  return path;
}

function simctlCalls(): string[][] {
  return readFileSync(log, "utf8")
    .trim()
    .split("\n")
    .filter(Boolean)
    .map((line) => (JSON.parse(line) as string[]).slice(1));
}

const verbs = () => simctlCalls().map((args) => args[0]);

test("opens the app after it installs when launch is set", async () => {
  const bundle = await app("Opens.app", "com.example.opens");
  const result = await runHostActionAsync(
    { action: "app.install", params: { udid: UDID.toLowerCase(), path: bundle, launch: true } },
    BIN,
  );
  expect(result).toMatchObject({ exitCode: 0 });
  const calls = simctlCalls();
  expect(calls[0]).toEqual(["install", UDID.toLowerCase(), bundle]);
  // The launch uses the canonical UDID and does not stop the app that simctl just installed.
  expect(calls.filter(([verb]) => verb === "launch")).toEqual([
    ["launch", UDID, "com.example.opens"],
  ]);
  expect(verbs()).not.toContain("terminate");
  expect(readLaunchState(UDID)).toMatchObject({ bundleId: "com.example.opens", launchArgs: [] });
});

test("only installs when launch is not set", async () => {
  const bundle = await app("Stays.app", "com.example.stays");
  const result = await runHostActionAsync(
    { action: "app.install", params: { udid: UDID, path: bundle } },
    BIN,
  );
  expect(result.exitCode).toBe(0);
  expect(verbs()).toEqual(["install"]);
  expect(readLaunchState(UDID)).toBeNull();
});

test.each([
  ["no bundle identifier", undefined],
  ["an invalid bundle identifier", "not a bundle id"],
])("reports an installed app with %s as not opened", async (_label, bundleId) => {
  const bundle = await app(`NoId-${bundleId ?? "none"}.app`.replaceAll(" ", "-"), bundleId);
  const result = await runHostActionAsync(
    { action: "app.install", params: { udid: UDID, path: bundle, launch: true } },
    BIN,
  );
  expect(result.exitCode).toBe(1);
  expect(result.stderr).toStartWith(`${APP_NOT_OPENED}\n`);
  expect(result.stderr).toContain("CFBundleIdentifier");
  expect(verbs()).toEqual(["install"]);
});

test("reports a launch failure after a successful install", async () => {
  const bundle = await app("LaunchFails.app", "com.example.fails");
  process.env.SERVE_SIM_FAIL_VERB = "launch";
  const stderr = spyOn(console, "error").mockImplementation(() => {});
  try {
    const result = await runHostActionAsync(
      { action: "app.install", params: { udid: UDID, path: bundle, launch: true } },
      BIN,
    );
    expect(result.exitCode).toBe(1);
    expect(result.stderr).toStartWith(`${APP_NOT_OPENED}\n`);
    expect(result.stderr).toContain("simctl launch failed");
    expect(verbs()).toContain("install");
  } finally {
    stderr.mockRestore();
  }
});

test("rejects launch for a device name before it installs", async () => {
  const bundle = await app("Named.app", "com.example.named");
  await expect(
    runHostActionAsync(
      { action: "app.install", params: { udid: "iPhone 17", path: bundle, launch: true } },
      BIN,
    ),
  ).rejects.toThrow(InvalidHostActionError);
  expect(verbs()).toEqual([]);
});

test("does not launch when the install fails", async () => {
  const bundle = await app("InstallFails.app", "com.example.install-fails");
  process.env.SERVE_SIM_FAIL_VERB = "install";
  const result = await runHostActionAsync(
    { action: "app.install", params: { udid: UDID, path: bundle, launch: true } },
    BIN,
  );
  expect(result.exitCode).not.toBe(0);
  expect(result.stderr).not.toContain(APP_NOT_OPENED);
  expect(verbs()).toEqual(["install"]);
});
