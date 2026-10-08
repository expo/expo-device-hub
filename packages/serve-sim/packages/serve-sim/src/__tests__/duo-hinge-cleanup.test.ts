import { expect, test } from "bun:test";
import { writeFileSync } from "fs";
import { stateFileForDevice } from "../state";
import type { HingePose } from "../hinge-control";
import type { NativeHingeState } from "../native";
import { withRestoredDuoHinge } from "./duo-hinge-helpers";
import { UDID, useTempStateDir } from "./helpers";

async function withHelper(original: NativeHingeState & { hingePose?: HingePose | null }, run: () => Promise<void>) {
  const temp = useTempStateDir();
  const server = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch: () => Response.json(original) });
  writeFileSync(stateFileForDevice(UDID), JSON.stringify({ device: UDID, streamUrl: `http://127.0.0.1:${server.port}/stream.mjpeg` }));
  try { await run(); } finally { server.stop(true); temp.restore(); }
}

function recordingHid() {
  const calls: unknown[][] = [];
  const hid = {
    async setHingePose(value: string) { calls.push(["pose", value]); return true; },
    async setHingeAngle(value: number) { calls.push(["angle", value]); return true; },
    async setPhysicalOrientation(value: NonNullable<NativeHingeState["physicalOrientation"]>) { calls.push(["physical", value]); return true; },
    async setTableMode(value: boolean) { calls.push(["table", value]); return true; },
  };
  return { hid, calls };
}

test("successful native tests restore the original Book pose rather than forcing Open or Tent", async () => {
  await withHelper({ hingePose: "book" }, async () => {
    const { hid, calls } = recordingHid();
    await withRestoredDuoHinge(UDID, async () => {}, hid);
    expect(calls).toEqual([["pose", "book"]]);
  });
});

test("a failed native test restores the original Tent pose and its Table Mode", async () => {
  await withHelper({ hingePose: "tent", hingeAngle: 80, tableMode: true }, async () => {
    const { hid, calls } = recordingHid();
    await expect(withRestoredDuoHinge(UDID, async () => { throw new Error("child failed"); }, hid)).rejects.toThrow("child failed");
    expect(calls).toEqual([["pose", "tent"]]);
  });
});

test("a custom angle restores physical orientation and Table Mode too", async () => {
  await withHelper({ hingePose: null, hingeAngle: 82, physicalOrientation: "facedown", tableMode: true }, async () => {
    const { hid, calls } = recordingHid();
    await withRestoredDuoHinge(UDID, async () => {}, hid);
    expect(calls).toEqual([["angle", 82], ["physical", "facedown"], ["table", true]]);
  });
});

test("an incomplete original state fails before the native test can move the device", async () => {
  await withHelper({ hingeAngle: 90, hingePose: null }, async () => {
    const { hid, calls } = recordingHid();
    let ran = false;
    await expect(withRestoredDuoHinge(UDID, async () => { ran = true; }, hid)).rejects.toThrow("known pose or complete");
    expect(ran).toBe(false);
    expect(calls).toEqual([]);
  });
});

test("a refused restoration fails the test instead of reporting successful cleanup", async () => {
  await withHelper({ hingePose: "open" }, async () => {
    const { hid } = recordingHid();
    hid.setHingePose = async () => false;
    await expect(withRestoredDuoHinge(UDID, async () => {}, hid)).rejects.toThrow("Could not restore");
  });
});
