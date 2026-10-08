import { expect, test } from "bun:test";
import { runChildSuite } from "./fixtures/run-child-suite";
import { withRestoredDuoHinge } from "./duo-hinge-helpers";

// Opt in with a booted iPhone Duo and its running helper in an explicitly set
// private SERVE_SIM_STATE_DIR. The helper must know the original pose/state.
// Both tests restore it in finally, including when the capture-first child fails.
const device = process.env.SERVE_SIM_DUO_E2E_DEVICE;

test.skipIf(!device)("Tent remains available when capture initializes before HID", async () => {
  await withRestoredDuoHinge(device!, async () => {
    const { exitCode, output } = await runChildSuite("duo-capture-first.child.ts", { timeoutMs: 20_000 });
    expect(output).toContain("1 pass");
    expect(exitCode, output).toBe(0);
  });
}, 45_000);

test.skipIf(!device)("physical orientation switches surfaces without moving the hinge", async () => {
  const { NativeHid } = await import("../native");
  const hid = new NativeHid(device!);
  await withRestoredDuoHinge(device!, async () => {
    expect(await hid.setHingePose("book")).toBe(true);
    expect(await hid.hingeState()).toMatchObject({
      hingeAngle: 90,
      physicalOrientation: "portrait",
      tableMode: false,
    });

    expect(await hid.setPhysicalOrientation("facedown")).toBe(true);
    expect(await hid.hingeState()).toMatchObject({
      hingeAngle: 90,
      physicalOrientation: "facedown",
      tableMode: true,
    });

    expect(await hid.setPhysicalOrientation("faceup")).toBe(true);
    expect(await hid.hingeState()).toMatchObject({
      hingeAngle: 90,
      physicalOrientation: "faceup",
      tableMode: false,
    });
  });
}, 20_000);
