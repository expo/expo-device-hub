import { execFileSync } from "node:child_process";
import { mkdtemp, writeFile, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { installAppAsync } from "../../app-install";

const root = await mkdtemp(join(tmpdir(), "fifo-probe-"));
try {
  const canary = join(root, "canary");
  await writeFile(canary, "owned probe");
  const paths = Array.from({ length: 5 }, (_, i) =>
    join(root, `input-${i}${i === 4 ? ".tar.gz" : ""}`),
  );
  execFileSync("mkfifo", paths);
  const started = Date.now();
  const installs = paths.map((path) =>
    installAppAsync("OWNED-PROBE", path, started + 3000, process.env.INSTALL_TEST_BIN!),
  );
  const readable = await Promise.race([
    readFile(canary, "utf8").then((value) => value === "owned probe"),
    new Promise<false>((resolve) => setTimeout(() => resolve(false), 500)),
  ]);
  const results = await Promise.all(installs);
  console.log(JSON.stringify({ readable, elapsed: Date.now() - started, results }));
} finally {
  await rm(root, { recursive: true, force: true });
}
