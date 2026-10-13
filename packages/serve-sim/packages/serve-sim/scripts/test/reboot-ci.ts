// Reboots the pinned CI simulator before the runner retries failed test files.
import { $ } from "bun";
import { listSimulators } from "./simulators";

const udid = process.env.SERVE_SIM_TEST_UDID;
if (!udid) throw new Error("Pin the CI simulator before the initial test attempt.");
const device = (await listSimulators("available")).find((d) => d.udid === udid);
if (!device) throw new Error(`Pinned simulator ${udid} is unavailable.`);
console.log(`Rebooting ${udid} before retrying failed files`);
if (device.state === "Booted") await $`xcrun simctl shutdown ${udid}`;
else if (device.state !== "Shutdown") throw new Error(`Unexpected simulator state: ${device.state}`);
await $`xcrun simctl boot ${udid}`;
await $`xcrun simctl bootstatus ${udid} -b`;
