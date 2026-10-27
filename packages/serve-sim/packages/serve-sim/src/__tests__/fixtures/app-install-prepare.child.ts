import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";

const directory = process.argv[4]!;
const app = join(directory, "Test.app");
mkdirSync(app, { recursive: true });
writeFileSync(process.env.INSTALL_PREPARE_REPORT!, directory);
console.log(JSON.stringify(app));
