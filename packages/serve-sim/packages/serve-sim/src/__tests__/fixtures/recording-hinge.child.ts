import { NativeHid } from "../../native";

const [udid, angle] = process.argv.slice(2);
if (!udid || angle === undefined) throw new Error("Expected device UDID and hinge angle");
const hid = new NativeHid(udid);
const target = Number(angle);
if (!await hid.setHingeAngle(target)) throw new Error("External hinge command failed");
const deadline = Date.now() + 5000;
while (Date.now() < deadline) {
  const state = await hid.hingeState();
  if (state.hingeAngle !== undefined && Math.abs(state.hingeAngle - target) < 0.01) process.exit(0);
  await Bun.sleep(100);
}
throw new Error(`External hinge did not settle to ${target}`);
