require("node:child_process").execFileSync = () => {
  throw Object.assign(new Error("spawnSync xcrun ETIMEDOUT"), {
    code: "ETIMEDOUT",
    signal: "SIGTERM",
    stderr: Buffer.alloc(0),
  });
};
require("node:module").syncBuiltinESMExports();
