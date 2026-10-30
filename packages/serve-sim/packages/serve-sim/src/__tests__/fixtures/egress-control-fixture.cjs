#!/usr/bin/env node
const fs = require("fs");
const { join } = require("node:path");
const work = process.env.SERVE_SIM_EGRESS_FIXTURE_DIRECTORY;
const [command, path, policy] = process.argv.slice(2);
if (command === "set" && fs.existsSync(join(work, "failing-set"))) {
  console.error("fixture set failed");
  process.exit(7);
}
if (command === "create") {
  const data = Buffer.alloc(4096);
  data.writeBigUInt64LE(0x5353454755415244n, 0);
  data.writeBigUInt64LE(policy === "block" ? 6n : 5n, 8);
  data.writeBigUInt64LE(policy === "block" ? 2n : 1n, 16);
  fs.writeFileSync(path, data, { flag: "wx", mode: 0o600 });
}
let data = fs.readFileSync(path),
  value = data.readBigUInt64LE(8);
if (command === "set") {
  value = (((value >> 2n) + 1n) << 2n) | (policy === "block" ? 2n : 1n);
  data.writeBigUInt64LE(value, 8);
  const fd = fs.openSync(path, "r+");
  fs.writeSync(fd, data);
  fs.closeSync(fd);
}
console.log(
  JSON.stringify({
    publishedGeneration: Number(value >> 2n),
    policy: (value & 3n) === 2n ? "block" : "passthrough",
    warmupPolicy: data.readBigUInt64LE(16) === 2n ? "block" : "passthrough",
    drained: false,
  }),
);
