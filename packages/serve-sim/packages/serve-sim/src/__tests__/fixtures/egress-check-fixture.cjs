#!/usr/bin/env node
// Modeled native self-check; resource tests do not execute Simulator binaries.
const fs = require("node:fs");
const [guard, page] = process.argv.slice(2);
if (!fs.existsSync(guard)) process.exit(1);
const failure = require("node:path").join(
  process.env.SERVE_SIM_EGRESS_FIXTURE_DIRECTORY,
  "failing-check",
);
const action = fs.existsSync(failure) ? fs.readFileSync(failure, "utf8") : "";
if (action === "fail") process.exit(3);
const data = fs.readFileSync(page);
const value = data.readBigUInt64LE(8);
const info = fs.statSync(page, { bigint: true });
console.log(
  JSON.stringify({
    publishedGeneration: Number(value >> 2n) + (action === "generation" ? 1 : 0),
    policy: action === "mode" ? "block" : (value & 3n) === 2n ? "block" : "passthrough",
    pageIdentity: action === "page" ? "0:0" : `${info.dev}:${info.ino}`,
  }),
);
