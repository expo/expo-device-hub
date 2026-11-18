#!/usr/bin/env node
const args = process.argv.slice(2);
if (args[1] === "shutdown" && process.env.SERVE_SIM_GRID_SHUTDOWN_FAIL === "1") {
  console.error("Unable to shutdown device");
  process.exit(1);
}
console.log(JSON.stringify({ devices: {} }));
