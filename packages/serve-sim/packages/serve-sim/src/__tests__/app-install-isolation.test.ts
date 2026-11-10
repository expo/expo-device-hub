import { expect, test } from "bun:test";
import { spawn, spawnSync } from "node:child_process";
import { chmod, copyFile, mkdir, mkdtemp, readFile, rm, utimes } from "node:fs/promises";
import { existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { installAppAsync } from "../app-install";
import { installShims, UDID } from "./helpers";
import { UPLOAD_DIR, UPLOAD_ROOT } from "../host-paths";
import { appendUploadChunkAsync, removeUploadAsync } from "../upload-store";

test("upload age pruning preserves an active extraction until its action deadline", async () => {
  const live = join(UPLOAD_DIR, `.install-extract-${Date.now() + 60_000}-live`);
  const expired = join(UPLOAD_DIR, `.install-extract-${Date.now() - 1}-expired`);
  try {
    for (const path of [live, expired]) {
      await mkdir(path, { recursive: true });
      await utimes(path, new Date(0), new Date(0));
    }
    expect(
      (
        await appendUploadChunkAsync({
          uploadId: "live-extraction-probe",
          data: "eA==",
          first: true,
        })
      ).exitCode,
    ).toBe(0);
    expect(existsSync(live)).toBe(true);
    expect(existsSync(expired)).toBe(false);
  } finally {
    await rm(live, { recursive: true, force: true });
    await rm(expired, { recursive: true, force: true });
    await removeUploadAsync("live-extraction-probe");
  }
});

test("another upload reclaims extraction files after the owning server exits", async () => {
  const root = await mkdtemp(join(tmpdir(), "interrupted-install-"));
  const prepared = join(root, "prepared"),
    installing = join(root, "installing");
  const shims = installShims({ xcrun: `#!/bin/sh\necho $$ > '${installing}'\nexec sleep 30\n` });
  let server: ReturnType<typeof spawn> | undefined, extraction: string | undefined;
  try {
    const cli = join(import.meta.dir, "fixtures/app-install-prepare.child.ts");
    server = spawn(
      process.execPath,
      [join(import.meta.dir, "fixtures/app-install-interrupted.child.ts")],
      {
        env: {
          ...process.env,
          INSTALL_PREPARE_BIN: cli,
          INSTALL_PREPARE_REPORT: prepared,
        },
        stdio: "ignore",
      },
    );
    const deadline = Date.now() + 5000;
    while (!existsSync(installing) && Date.now() < deadline) await Bun.sleep(10);
    expect(existsSync(installing)).toBe(true);
    extraction = (await readFile(prepared, "utf8")).trim();
    const exited = new Promise((resolve) => server!.once("exit", resolve));
    server.kill("SIGKILL");
    await exited;
    expect(dirname(extraction).startsWith(join(UPLOAD_ROOT, `${server.pid}-`))).toBe(true);
    expect(existsSync(extraction)).toBe(true);
    expect(
      (
        await appendUploadChunkAsync({
          uploadId: "orphan-extraction-probe",
          data: "eA==",
          first: true,
        })
      ).exitCode,
    ).toBe(0);
    expect(existsSync(extraction)).toBe(false);
  } finally {
    if (server?.exitCode === null && server.signalCode === null) server.kill("SIGKILL");
    if (existsSync(installing)) {
      const pid = Number(await readFile(installing, "utf8"));
      try {
        process.kill(pid, "SIGKILL");
      } catch {
        /* The owned install may already have exited. */
      }
    }
    if (
      extraction &&
      (basename(extraction).startsWith(`serve-sim-app-install-${server?.pid}-`) ||
        dirname(extraction).startsWith(join(UPLOAD_ROOT, `${server?.pid}-`)))
    )
      await rm(extraction, { recursive: true, force: true });
    await removeUploadAsync("orphan-extraction-probe");
    shims.restore();
    await rm(root, { recursive: true, force: true });
  }
}, 10000);

test("FIFO install sources cannot exhaust the Node server's filesystem pool", async () => {
  const directory = await mkdtemp(join(tmpdir(), "install-isolation-test-"));
  try {
    const built = spawnSync(
      process.execPath,
      [
        "build",
        fileURLToPath(new URL("./fixtures/app-install-fifo.child.ts", import.meta.url)),
        "--target=node",
        "--format=esm",
        "--outdir",
        directory,
      ],
      { encoding: "utf8", timeout: 10000 },
    );
    expect(built.status, built.stderr).toBe(0);
    const result = spawnSync("node", [join(directory, "app-install-fifo.child.js")], {
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
      await copyFile(join(import.meta.dir, `fixtures/app-install-source.child.${extension}`), cli);
      await chmod(cli, 0o600);
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
