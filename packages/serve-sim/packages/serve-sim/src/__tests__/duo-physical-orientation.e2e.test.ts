import { expect, test } from "bun:test";

// Opt in with a booted iPhone Duo. This changes the device's physical pose and
// restores the repository's standard Tent verification pose when it finishes.
const device = process.env.SERVE_SIM_DUO_E2E_DEVICE;

test.skipIf(!device)("physical orientation switches surfaces without moving the hinge", async () => {
  const { NativeHid } = await import("../native");
  const hid = new NativeHid(device!);
  try {
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
  } finally {
    await hid.setHingePose("tent");
  }
}, 20_000);
