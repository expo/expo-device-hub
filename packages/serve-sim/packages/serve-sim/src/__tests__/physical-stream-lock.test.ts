import { afterEach, beforeEach, expect, test } from "bun:test";
import { existsSync, readFileSync, writeFileSync } from "fs";
import { join } from "path";

import {
  DeviceInUseError,
  claimPhysicalStream,
  physicalStreamHolder,
} from "../physical-stream-lock";
import { useTempStateDir } from "./helpers";

const PHONE = "00008101-0016603236F0801E";
let state: ReturnType<typeof useTempStateDir>;
const lockFile = () => join(state.dir, `physical-stream-${PHONE}.lock`);

beforeEach(() => {
  state = useTempStateDir();
});
afterEach(() => state.restore());

async function exitedPid(): Promise<number> {
  const child = Bun.spawn(["true"]);
  await child.exited;
  return child.pid;
}

test("a server claims a phone's stream and releases it", () => {
  const release = claimPhysicalStream(PHONE.toLowerCase());

  expect(readFileSync(lockFile(), "utf8")).toBe(String(process.pid));
  expect(physicalStreamHolder(PHONE)).toBeNull();
  release();
  expect(existsSync(lockFile())).toBe(false);
});

test("a phone that another live server streams is refused with that server's pid", () => {
  writeFileSync(lockFile(), String(process.ppid));

  expect(physicalStreamHolder(PHONE)).toBe(process.ppid);
  expect(() => claimPhysicalStream(PHONE)).toThrow(DeviceInUseError);
  expect(() => claimPhysicalStream(PHONE)).toThrow(
    `iPhone is streaming in another serve-sim (pid ${process.ppid})`,
  );
  expect(readFileSync(lockFile(), "utf8")).toBe(String(process.ppid));
});

test("a claim left by a server that exited is taken over", async () => {
  writeFileSync(lockFile(), String(await exitedPid()));

  expect(physicalStreamHolder(PHONE)).toBeNull();
  const release = claimPhysicalStream(PHONE);
  expect(readFileSync(lockFile(), "utf8")).toBe(String(process.pid));
  release();
});

test("releasing does not remove another server's claim", () => {
  const release = claimPhysicalStream(PHONE);
  writeFileSync(lockFile(), String(process.ppid));

  release();

  expect(readFileSync(lockFile(), "utf8")).toBe(String(process.ppid));
});
