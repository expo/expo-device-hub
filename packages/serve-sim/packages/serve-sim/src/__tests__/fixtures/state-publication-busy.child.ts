import { expect, test } from "bun:test";
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { gridDeviceState, writeServeSimState } from "../../state";
import { useTempStateDir } from "../helpers";

test("preview publication refuses a busy device without blocking the server", () => {
  const state = useTempStateDir();
  try {
    writeFileSync(join(state.dir, "launch-busy.lock"), String(process.ppid));
    expect(() => writeServeSimState(gridDeviceState("busy", 3240, "/"))).toThrow();
    writeFileSync(join(state.dir, "launch-busy.lock"), "2147483647");
    expect(() => writeServeSimState(gridDeviceState("busy", 3240, "/"))).not.toThrow();
  } finally {
    state.restore();
  }
});
