import { expect, test } from "bun:test";
import { DeviceSession } from "../device-session";

test("the shake message shakes the device once and logs it", async () => {
  const shakes: string[] = [];
  const logged: number[] = [];
  const s = Object.create(DeviceSession.prototype);
  Object.assign(s, {
    udid: `SHAKE-${process.pid}`,
    phase: "running",
    hid: {
      inputUnavailable: false,
      shake: async () => {
        shakes.push("shake");
      },
    },
    recordHidEvent: (tag: number) => logged.push(tag),
  });

  await s.handleHidMessage(Buffer.from([0x14]), {});

  expect(shakes).toEqual(["shake"]);
  expect(logged).toEqual([0x14]);
});
