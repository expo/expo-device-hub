import { expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { installAppAsync } from "../app-install";
import { installShims, UDID } from "./helpers";

test("FIFO install sources cannot exhaust the Node server's filesystem pool", async () => {
  const directory = await mkdtemp(join(tmpdir(), "install-isolation-test-"));
  try {
    const built = await Bun.build({
      entrypoints: [
        fileURLToPath(new URL("./fixtures/app-install-fifo.child.ts", import.meta.url)),
      ],
      target: "node",
      format: "esm",
      outdir: directory,
    });
    expect(built.success).toBe(true);
    const result = spawnSync("node", [built.outputs[0]!.path], {
      timeout: 5000,
      encoding: "utf8",
      env: {
        ...process.env,
        UV_THREADPOOL_SIZE: "4",
        INSTALL_TEST_BIN: fileURLToPath(new URL("../../dist/serve-sim.js", import.meta.url)),
      },
    });
    expect(result.error).toBeUndefined();
    expect(result.status, result.stderr).toBe(0);
    const report = JSON.parse(result.stdout);
    expect(report.readable).toBe(true);
    expect(report.results).toHaveLength(5);
    for (const install of report.results)
      expect(install).toMatchObject({
        exitCode: 1,
        stderr: expect.stringContaining("regular file"),
      });
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("a stalled preparation child is killed and reported as an install timeout", async () => {
  const shims = installShims({ prepare: "#!/bin/sh\nexec sleep 10\n" });
  const start = Date.now();
  try {
    const result = await installAppAsync(
      UDID,
      "/unused",
      Date.now() + 50,
      join(shims.dir, "prepare"),
    );
    expect(result).toMatchObject({
      exitCode: 1,
      timedOut: true,
      stderr: "App installation timed out.",
    });
    expect(Date.now() - start).toBeLessThan(1500);
  } finally {
    shims.restore();
  }
});

test.each(["js", "ts"])(
  "preparation launches a non-executable %s CLI with its runtime",
  async (extension) => {
    const directory = await mkdtemp(join(tmpdir(), "install-cli-runtime-"));
    const shims = installShims({ xcrun: "#!/bin/sh\nexit 0\n" });
    try {
      const cli = join(directory, `prepare.${extension}`);
      await writeFile(
        cli,
        extension === "ts"
          ? "const source: string = process.argv[3]!; console.log(JSON.stringify(source));"
          : "console.log(JSON.stringify(process.argv[3]));",
        { mode: 0o600 },
      );
      const result = await installAppAsync(UDID, "/unused", Date.now() + 3000, cli);
      expect(result.exitCode, result.stderr).toBe(0);
    } finally {
      shims.restore();
      await rm(directory, { recursive: true, force: true });
    }
  },
);

test.each([
  ["cleanup gets grace after the action deadline", 1.2, 1000],
  ["cleanup uses remaining action time beyond its minimum grace", 11.2, 20_000],
] as const)(
  "%s",
  async (_name, delay, budgetMs) => {
    const shims = installShims({
      xcrun: "#!/bin/sh\nexit 0\n",
      prepare: '#!/bin/sh\nprintf \'"%s"\\n\' "$2"\n',
      rm: `#!/bin/sh\nsleep ${delay}\nexec /bin/rm "$@"\n`,
    });
    try {
      const result = await installAppAsync(
        UDID,
        "/unused",
        Date.now() + budgetMs,
        join(shims.dir, "prepare"),
      );
      expect(result.exitCode).toBe(0);
      expect(result.stderr).toBe("");
    } finally {
      shims.restore();
    }
  },
  25_000,
);
