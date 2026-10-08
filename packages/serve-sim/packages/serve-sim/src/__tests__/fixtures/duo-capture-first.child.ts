import { expect, test } from "bun:test";
import { NativeCapture, NativeHid } from "../../native";
import { withRestoredDuoHinge } from "../duo-hinge-helpers";

// A fresh process is essential: framework availability is cached process-wide.
// Only the explicitly supplied Duo is touched, never an arbitrary booted device.
const device = process.env.SERVE_SIM_DUO_E2E_DEVICE;

test.skipIf(!device)("capture-first initialization can apply Tent", async () => {
  await withRestoredDuoHinge(device!, async () => {
    const capture = new NativeCapture(device!);
    const hid = new NativeHid(device!);
    try {
      await capture.start();
      const initial = await capture.screenSize();
      await hid.setScreen(initial.screenId ?? 0);
      expect(await hid.supportsHingeAngle()).toBe(true);
      expect(await hid.supportsPhysicalOrientation()).toBe(true);
      expect(await hid.setHingePose("tent")).toBe(true);
      expect(await hid.hingeState()).toMatchObject({ hingeAngle: 80, physicalOrientation: "facedown", tableMode: true });
      const deadline = Date.now() + 3000;
      while ((await capture.screenSize()).screenId !== 1 && Date.now() < deadline) await Bun.sleep(20);
      expect((await capture.screenSize()).screenId).toBe(1);
    } finally {
      await capture.stop();
    }
  });
}, 15_000);
