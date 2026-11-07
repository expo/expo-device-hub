const childProcess = require("node:child_process");
let now = 0;
let reads = 0;
Date.now = () => now;
childProcess.execFileSync = (_file, args) => {
  if (args[1] === "privacy") return "";
  if (args.includes("location") && args.includes("get")) {
    reads++;
    now += 6000;
    if (reads === 1 || process.env.LOCATION_CONFIRMATION_STALE === "1")
      return JSON.stringify({ Authorization: 1 });
    return JSON.stringify({ Authorization: 2 });
  }
  throw new Error("Unexpected subprocess in location confirmation fixture");
};
require("node:module").syncBuiltinESMExports();
