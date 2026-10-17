import { expect, test } from "bun:test";
import type { NativeHingeState } from "../native";

// Opt in with a booted iPhone Duo. This changes the device's physical pose and
// restores the repository's standard Tent verification pose when it finishes.
const device = process.env.SERVE_SIM_DUO_E2E_DEVICE;

test.skipIf(!device)(
  "physical orientation switches surfaces without moving the hinge",
  async () => {
    const { NativeCapture, NativeHid } = await import("../native");
    const hid = new NativeHid(device!);
    const capture = new NativeCapture(device!);
    let observed: NativeHingeState = {};
    let unsubscribe: (() => Promise<void>) | undefined;
    const waitForState = async (expected: NativeHingeState) => {
      const matches = () =>
        Object.entries(expected).every(([key, value]) =>
          key === "hingeAngle" && typeof value === "number"
            ? observed.hingeAngle !== undefined && Math.abs(observed.hingeAngle - value) <= 1
            : observed[key as keyof NativeHingeState] === value,
        );
      const deadline = Date.now() + 5000;
      while (!matches() && Date.now() < deadline) await Bun.sleep(50);
      const { hingeAngle, ...pose } = expected;
      expect(observed).toMatchObject(pose);
      if (hingeAngle !== undefined)
        expect(Math.abs(observed.hingeAngle! - hingeAngle)).toBeLessThanOrEqual(1);
    };
    try {
      await capture.start();
      unsubscribe = await capture.subscribeDeviceState(async (snapshot) => {
        observed = snapshot.state;
      });
      expect(await hid.setHingePose("book")).toBe(true);
      await waitForState({
        hingeAngle: 90,
        physicalOrientation: "portrait",
        tableMode: false,
      });

      expect(await hid.setPhysicalOrientation("facedown")).toBe(true);
      await waitForState({
        hingeAngle: 90,
        physicalOrientation: "facedown",
        tableMode: true,
      });

      expect(await hid.setPhysicalOrientation("faceup")).toBe(true);
      await waitForState({
        hingeAngle: 90,
        physicalOrientation: "faceup",
        tableMode: false,
      });
    } finally {
      try {
        await hid.setHingePose("tent");
      } finally {
        try {
          await unsubscribe?.();
        } finally {
          await capture.stop();
        }
      }
    }
  },
  20_000,
);
