import { serveSimCliPath } from "../../cli-path";

console.log(JSON.stringify({ cli: serveSimCliPath(), executable: process.execPath }));
