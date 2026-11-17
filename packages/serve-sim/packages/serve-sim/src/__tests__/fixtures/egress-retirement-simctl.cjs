#!/usr/bin/env node
const fs = require("node:fs");
const path = require("node:path");
const work = process.env.SERVE_SIM_EGRESS_FIXTURE_DIRECTORY;
const args = process.argv.slice(2);
if (args.join(" ") !== "simctl list devices -j") {
  console.error("Unexpected fixture command");
  process.exit(97);
}
console.log(fs.readFileSync(path.join(work, "device-state.json"), "utf8"));
