import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { execFileSync, spawnSync } from "child_process";
import { existsSync, mkdirSync, mkdtempSync, rmSync } from "fs";
import { tmpdir } from "os";
import { dirname, join } from "path";
import { requireE2E } from "./e2e-preconditions";

const CLI_PATH = join(import.meta.dir, "../../dist/serve-sim.js");
const UDID = "00000000-0000-0000-0000-000000000001";
const SERVICES = 4000;

requireE2E("permissions list", existsSync(CLI_PATH));

describe.skipIf(!existsSync(CLI_PATH))("permissions list", () => {
  let home: string;
  let nodePath: string;

  beforeAll(() => {
    nodePath = execFileSync("node", ["-p", "process.execPath"], { encoding: "utf8" }).trim();
    home = mkdtempSync(join(tmpdir(), "serve-sim-permissions-"));
    const db = join(home, "Library/Developer/CoreSimulator/Devices", UDID, "data/Library/TCC/TCC.db");
    mkdirSync(dirname(db), { recursive: true });
    const database = new Database(db);
    database.run(
      "CREATE TABLE access (service TEXT, client TEXT, client_type INTEGER, auth_value INTEGER, auth_reason INTEGER, auth_version INTEGER, flags INTEGER)",
    );
    database.run(
      `WITH RECURSIVE n(i) AS (SELECT 1 UNION ALL SELECT i + 1 FROM n WHERE i < ${SERVICES}) ` +
        "INSERT INTO access SELECT 'kTCCServiceGenerated' || i, 'com.example.app', 0, 2, 2, 1, 0 FROM n",
    );
    database.close();
  });

  afterAll(() => {
    rmSync(home, { recursive: true, force: true });
  });

  test("returns a large listing in full to a Node parent that reads it asynchronously", () => {
    const parent = `
      require("child_process").execFile(
        process.execPath,
        ${JSON.stringify([CLI_PATH, "permissions", "list", "-d", UDID])},
        { maxBuffer: 16 * 1024 * 1024 },
        (error, stdout) => {
          process.stdout.write(stdout);
          process.exitCode = error ? 1 : 0;
        },
      );
    `;
    const result = spawnSync(nodePath, ["-e", parent], {
      encoding: "utf8",
      env: { ...process.env, HOME: home },
      maxBuffer: 16 * 1024 * 1024,
      timeout: 30_000,
    });

    expect(result.status).toBe(0);
    expect(result.stdout.length).toBeGreaterThan(64 * 1024);
    expect(Object.keys(JSON.parse(result.stdout).tcc)).toHaveLength(SERVICES);
  });
});
