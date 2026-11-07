const fs = require("node:fs");
const { join } = require("node:path");

const action = process.argv[3];
fs.appendFileSync(join(__dirname, "events"), action + "\n");
const blocked = fs.existsSync(join(__dirname, `block-${action}`));
if (action === "reset" || blocked) {
  const timer = setInterval(() => {
    if (fs.existsSync(join(__dirname, blocked ? `release-${action}` : "release"))) {
      clearInterval(timer);
      process.exit(0);
    }
  }, 10);
}
