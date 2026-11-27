const assert = require("node:assert/strict");
const childProcess = require("node:child_process");
const os = require("node:os");
const { join } = require("node:path");

const home = process.env.PERMISSION_TEST_HOME;
assert.ok(home);
os.homedir = () => home;

const execFileSync = childProcess.execFileSync;
childProcess.execFileSync = (file, args, options) => {
  if (process.env.PERMISSION_TEST_LOCK_FAILURE === "1") {
    if (file === "/usr/bin/chflags") throw new Error(`Could not change flags under ${home}`);
    if (file === "xcrun") process.exit(91);
  }
  if (file !== "xcrun") return execFileSync(file, args, options);
  const [, , udid, , family, action] = args;
  assert.equal(family, "notifications");
  assert.equal(action, "revoke");
  const plist = join(
    home,
    "Library/Developer/CoreSimulator/Devices",
    udid,
    "data/Library/BulletinBoard/VersionedSectionInfo.plist",
  );
  const flags = execFileSync("/usr/bin/stat", ["-f", "%Sf", plist], { encoding: "utf8" });
  assert.equal(flags.trim(), "nodump");
  return "{}";
};
require("node:module").syncBuiltinESMExports();
