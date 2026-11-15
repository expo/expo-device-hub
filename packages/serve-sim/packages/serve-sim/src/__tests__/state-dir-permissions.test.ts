import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { chmodSync, mkdirSync, mkdtempSync, rmSync, statSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { ensureStateDir, stateDir } from "../state";
import { writeLaunchState } from "../launch-state";

let root: string;
const saved = { state: process.env.SERVE_SIM_STATE_DIR, tmp: process.env.TMPDIR };

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "serve-sim-state-dir-"));
});

afterEach(() => {
  if (saved.state === undefined) delete process.env.SERVE_SIM_STATE_DIR;
  else process.env.SERVE_SIM_STATE_DIR = saved.state;
  if (saved.tmp === undefined) delete process.env.TMPDIR;
  else process.env.TMPDIR = saved.tmp;
  rmSync(root, { recursive: true, force: true });
});

const mode = (path: string) => statSync(path).mode & 0o777;

describe("serve-sim state directory", () => {
  test("a new state directory is private to the current user", () => {
    process.env.SERVE_SIM_STATE_DIR = join(root, "nested", "state");
    ensureStateDir();
    expect(mode(stateDir())).toBe(0o700);
  });

  test("launch state creates its directory privately", () => {
    process.env.SERVE_SIM_STATE_DIR = join(root, "state");
    writeLaunchState("PRIVATE-STATE-DIR", { launchArgs: [], capabilities: {} });
    expect(mode(stateDir())).toBe(0o700);
  });

  test("an existing default directory from an older release becomes private", () => {
    delete process.env.SERVE_SIM_STATE_DIR;
    process.env.TMPDIR = root;
    mkdirSync(stateDir());
    chmodSync(stateDir(), 0o755);
    ensureStateDir();
    expect(mode(stateDir())).toBe(0o700);
  });

  test("a directory chosen with SERVE_SIM_STATE_DIR keeps its permissions", () => {
    process.env.SERVE_SIM_STATE_DIR = join(root, "shared");
    mkdirSync(stateDir());
    chmodSync(stateDir(), 0o755);
    ensureStateDir();
    expect(mode(stateDir())).toBe(0o755);
  });
});
