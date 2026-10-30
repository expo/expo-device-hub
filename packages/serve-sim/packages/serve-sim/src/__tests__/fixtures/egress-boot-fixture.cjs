#!/usr/bin/env node
const { join } = require("node:path");
const work = process.env.SERVE_SIM_EGRESS_FIXTURE_DIRECTORY;
const fs = require("fs");
async function main() {
  if (fs.existsSync(join(work, "pause-boot"))) {
    fs.writeFileSync(join(work, "entered-boot"), "entered");
    while (fs.existsSync(join(work, "pause-boot"))) await new Promise((r) => setTimeout(r, 5));
  }
  console.log(fs.readFileSync(join(work, "boot.json"), "utf8"));
}
main();
