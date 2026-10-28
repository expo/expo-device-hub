import { Database } from "bun:sqlite";

const db = new Database(process.argv[2]);
db.exec("BEGIN EXCLUSIVE");
console.log("locked");
await Bun.sleep(Number(process.argv[3]) * 1000);
db.exec("ROLLBACK");
db.close();
