#!/usr/bin/env node
const { appendFileSync } = require("node:fs");

appendFileSync(
  process.env.EGRESS_BOOT_TEST_LOG,
  JSON.stringify({
    args: process.argv.slice(2),
    insert: process.env.SIMCTL_CHILD_DYLD_INSERT_LIBRARIES,
    config: process.env.SIMCTL_CHILD_SERVE_SIM_CAPABILITIES_CONFIG,
  }) + "\n",
);
process.stdout.write("shim-output\n");
