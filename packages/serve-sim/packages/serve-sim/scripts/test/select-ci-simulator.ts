// Prints the UDID of the CI worker's booted simulator, or of SERVE_SIM_TEST_UDID if it is booted.
import { listSimulators } from "./simulators";

const requested = process.env.SERVE_SIM_TEST_UDID?.trim();
const device = (await listSimulators("booted")).find(
  (d) => d.state === "Booted" && (!requested || d.udid === requested),
);
if (!device) {
  throw new Error(requested ? `Pinned simulator ${requested} is not booted.` : "No booted CI simulator found.");
}
console.log(device.udid);
