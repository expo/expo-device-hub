import { afterEach, beforeEach, expect, test } from "bun:test";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ControlInputQueue } from "../src/control-input-queue.ts";
import { createApp, type EmuApp } from "../src/middleware.ts";

const fixtureDir = process.env.SERVE_EMU_UIMODE_TEST_DIR;

if (!fixtureDir) {
  // Bun resolves bare executable names using its startup PATH. Isolate the ADB
  // fixture in a child test process so other tests never inherit its PATH.
  test("middleware Appearance subprocess regressions", async () => {
    const dir = await mkdtemp(join(tmpdir(), "serve-emu-uimode-"));
    try {
      await writeFile(
        join(dir, "adb"),
        `#!${process.execPath}
import { appendFileSync, existsSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
const dir = dirname(import.meta.path);
const args = Bun.argv.slice(2);
if (args.slice(0, 6).join(" ") !== "-s emulator-test shell cmd uimode night") process.exit(2);
appendFileSync(join(dir, "commands"), JSON.stringify(args) + "\\n");
writeFileSync(join(dir, "started"), "");
while (existsSync(join(dir, "hold"))) await Bun.sleep(10);
if (existsSync(join(dir, "error"))) {
  console.error("uimode unavailable");
  process.exit(1);
}
if (args.length === 7) writeFileSync(join(dir, "night"), args[6]);
else console.log("Night mode: " + readFileSync(join(dir, "night"), "utf8"));
`,
        { mode: 0o755 },
      );

      const child = Bun.spawn([process.execPath, "test", import.meta.path], {
        env: {
          ...process.env,
          PATH: `${dir}:${process.env.PATH ?? ""}`,
          SERVE_EMU_UIMODE_TEST_DIR: dir,
        },
        stdout: "pipe",
        stderr: "pipe",
      });
      const [code, stdout, stderr] = await Promise.all([
        child.exited,
        new Response(child.stdout).text(),
        new Response(child.stderr).text(),
      ]);
      if (code !== 0) throw new Error(`Appearance regressions failed:\n${stdout}${stderr}`);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  }, 30_000);
} else {
  let dir: string;
  let app: EmuApp;

  beforeEach(async () => {
    dir = fixtureDir;
    await writeFile(join(dir, "night"), "no");

    const controls = new ControlInputQueue({ writer: { async write() {} } });
    let end!: (value: null) => void;
    const frames = new Promise<null>((resolve) => {
      end = resolve;
    });
    app = await createApp(
      { serial: "emulator-test" },
      {
        startSession: async () => ({
          serial: "emulator-test",
          mode: "scrcpy",
          inputSource: "scrcpy",
          meta: { deviceName: "test", codecId: "h264", width: 576, height: 1280 },
          controls,
          readFrame: () => frames,
          onFatal: () => () => {},
          async close() {
            controls.close();
            end(null);
          },
        }),
        clock: { now: () => 0, setInterval: () => 0, clearInterval: () => {} },
      },
    );
  });

  afterEach(async () => {
    await app?.stop();
    await Promise.all(
      ["night", "commands", "started", "hold", "error"].map((name) =>
        rm(join(dir, name), { force: true }),
      ),
    );
  });

  function request(method = "GET", body?: unknown) {
    return app.handleRequest(
      new Request("http://hub.test/api/uimode", {
        method,
        ...(body === undefined
          ? {}
          : {
              headers: { "Content-Type": "application/json" },
              body: JSON.stringify(body),
            }),
      }),
    );
  }

  test.each(["yes", "no", "auto"])("GET preserves the %s wire value", async (night) => {
    await writeFile(join(dir, "night"), night);
    const response = await request();
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ ok: true, night });
  });

  test.each(["yes", "no", "auto"])("POST applies and returns the %s wire value", async (night) => {
    const response = await request("POST", { night });
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ ok: true, night });
    expect(await readFile(join(dir, "night"), "utf8")).toBe(night);
    const commands = (await readFile(join(dir, "commands"), "utf8"))
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line));
    expect(commands).toEqual([
      ["-s", "emulator-test", "shell", "cmd", "uimode", "night", night],
      ["-s", "emulator-test", "shell", "cmd", "uimode", "night"],
    ]);
  });

  test("rejects invalid modes before invoking ADB", async () => {
    for (const body of [{ night: "dark" }, { night: true }, {}, null, ["yes"]]) {
      const response = await request("POST", body);
      expect(response.status).toBe(400);
      expect(await response.json()).toEqual({
        ok: false,
        error: 'night must be one of "yes", "no", or "auto"',
      });
    }
    expect(await Bun.file(join(dir, "commands")).exists()).toBe(false);
  });

  test.each(["GET", "POST"])(
    "%s leaves the event loop and health endpoint responsive during ADB",
    async (method) => {
      await writeFile(join(dir, "hold"), "");
      let settled = false;
      const pending = request(method, method === "POST" ? { night: "yes" } : undefined).then(
        (response) => {
          settled = true;
          return response;
        },
      );
      try {
        const deadline = Date.now() + 1_000;
        while (!(await Bun.file(join(dir, "started")).exists())) {
          if (Date.now() > deadline) throw new Error("ADB did not start");
          await Bun.sleep(10);
        }
        expect(settled).toBe(false);
        const health = await app.handleRequest(new Request("http://hub.test/health"));
        expect(health.status).toBe(200);
        expect(settled).toBe(false);
      } finally {
        await rm(join(dir, "hold"), { force: true });
        await pending;
      }
      expect((await pending).status).toBe(200);
    },
    6_000,
  );

  test("returns structured ADB errors for reads and writes", async () => {
    await writeFile(join(dir, "error"), "");
    for (const method of ["GET", "POST"]) {
      const response = await request(method, method === "POST" ? { night: "yes" } : undefined);
      expect(response.status).toBe(400);
      const body = (await response.json()) as { ok: boolean; error: string };
      expect(body.ok).toBe(false);
      expect(body.error).toContain("uimode unavailable");
    }
  });

  test("a stalled read reaches the executor deadline and a later read recovers", async () => {
    await writeFile(join(dir, "hold"), "");
    const response = await request();
    expect(response.status).toBe(400);
    expect(await response.json()).toEqual({
      ok: false,
      error: "cmd uimode night failed: command deadline exceeded after 2000ms",
    });
    await rm(join(dir, "hold"));
    expect(await (await request()).json()).toEqual({ ok: true, night: "no" });
  }, 6_000);
}
