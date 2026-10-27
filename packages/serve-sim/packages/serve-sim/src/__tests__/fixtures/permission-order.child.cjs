const fs = require("node:fs");
const { join } = require("node:path");

const action = process.argv[3];
fs.appendFileSync(join(__dirname, "events"), action + "\n");
if (action === "reset") {
  const timer = setInterval(() => {
    if (fs.existsSync(join(__dirname, "release"))) {
      clearInterval(timer);
      process.exit(0);
    }
  }, 10);
}
