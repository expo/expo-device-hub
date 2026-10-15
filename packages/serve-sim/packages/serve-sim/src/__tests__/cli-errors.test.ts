import { afterAll, beforeAll, expect, test } from "bun:test";
import { spawnSync } from "child_process";
import { join } from "path";
import { inProcessServeSimState, writeServeSimState } from "../state";
import { freePortAsync, installShims, useTempStateDir } from "./helpers";

const CLI_PATH = join(import.meta.dir, "../../src/index.ts");
const device = `00000000-0000-0000-0000-${String(process.pid).padStart(12, "0")}`;

let tempState: ReturnType<typeof useTempStateDir>;
let shims: ReturnType<typeof installShims>;

beforeAll(async () => {
  tempState = useTempStateDir();
  shims = installShims({ xcrun: "#!/bin/sh\nexit 1\n" });
  writeServeSimState(inProcessServeSimState(device, await freePortAsync()));
});

afterAll(() => {
  shims?.restore();
  tempState?.restore();
});

function hinge(...values: string[]) {
  const args = ["hinge", ...values, "-d", device];
  return spawnSync(process.execPath, [CLI_PATH, ...args], {
    encoding: "utf8",
    env: { ...process.env },
    timeout: 15_000,
  });
}

test("prints a failed hinge change without a stack trace", () => {
  const result = hinge("half");

  expect(result.status).toBe(1);
  expect(result.stderr).toContain("Hinge control connection failed");
  expect(result.stderr).not.toMatch(/^\s+at /m);
  expect(result.stderr).not.toMatch(/^\d+ \| /m);
});

test("prints a failed hinge read without a stack trace", () => {
  const result = hinge();

  expect(result.status).toBe(1);
  expect(result.stderr).toContain("Hinge state connection failed");
  expect(result.stderr).not.toMatch(/^\s+at /m);
  expect(result.stderr).not.toMatch(/^\d+ \| /m);
});
