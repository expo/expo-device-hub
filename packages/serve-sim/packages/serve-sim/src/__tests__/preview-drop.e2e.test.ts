import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { execFileSync, spawnSync } from "node:child_process";
import {
  cpSync,
  readFileSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { c as createTar } from "tar";
import { CHROME, startTestBrowser } from "./browser-e2e";
import { parseDetachState } from "./detach-state";
import { e2eDevice, requireE2E } from "./e2e-preconditions";
import { freePortAsync } from "./helpers";
import type { ServeSimDeviceState } from "../state";

const CLI = join(import.meta.dir, "../../dist/serve-sim.js");
const FIXTURE = join(import.meta.dir, "../../dist/capability-loader/ServeSimLaunchFixture.app");
const APP = "dev.expo.serve-sim.drop-fixture";
const sourceUdid = e2eDevice();
let udid: string | undefined;
const ready = sourceUdid !== null && existsSync(CLI) && existsSync(CHROME);
const fixtureReady = existsSync(FIXTURE);
requireE2E("preview file drops (requires Chrome)", ready);
const PNG = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jRz0AAAAASUVORK5CYII=",
  "base64",
);

describe.skipIf(!ready)("preview file drops through the real action channel", () => {
  let root: string;
  let env: NodeJS.ProcessEnv;
  let browser: Awaited<ReturnType<typeof startTestBrowser>>;
  let previewUrl: string;
  const sent: Array<{ id: number; action: string; params: Record<string, unknown> }> = [];
  const replies = new Map<number, { exitCode?: number; stderr?: string }>();
  const workers: string[] = [];

  function simctl(...args: string[]): string {
    return execFileSync("xcrun", ["simctl", ...args], {
      encoding: "utf8",
      timeout: 30000,
      stdio: "pipe",
    });
  }

  async function until(check: () => boolean | Promise<boolean>, message: string, budget = 30000) {
    const deadline = Date.now() + budget;
    while (Date.now() < deadline) {
      if (await check()) return;
      await Bun.sleep(100);
    }
    const body = browser
      ? await browser.cdp.evaluate<string>(
          "[...document.querySelectorAll('[data-testid=upload-toast]')].map(el => el.textContent).join('\\n')",
        )
      : "";
    throw new Error(
      `${message}: ${JSON.stringify({ body, requests: sent.map(({ id, action }) => ({ action, reply: replies.get(id) })) })}`,
    );
  }

  function photoCount(): number {
    const home = simctl("getenv", udid!, "HOME").trim();
    const database = join(home, "Media/PhotoData/Photos.sqlite");
    if (!existsSync(database)) return 0;
    return Number(
      execFileSync("sqlite3", [database, "SELECT COUNT(*) FROM ZASSET"], {
        encoding: "utf8",
        timeout: 5000,
      }),
    );
  }

  async function drop(files: Array<{ name: string; bytes: Buffer }>) {
    const paths = files.map(({ name, bytes }) => {
      const path = join(root, name);
      writeFileSync(path, bytes);
      return path;
    });
    await dropPaths(paths);
  }

  /** Drops on the stream. With `frame`, the preview is in that iframe session of the page. */
  async function dropPaths(paths: string[], frame?: string) {
    // Errors now remain until dismissed; each scenario starts with a clear drop target.
    await browser.cdp.evaluate(
      "document.querySelectorAll('[aria-label=\"Dismiss upload error\"]').forEach(button => button.click())",
      frame,
    );
    sent.length = 0;
    replies.clear();
    const point = await browser.cdp.evaluate<{ x: number; y: number }>(
      `(() => {
      const layer = [...document.querySelectorAll('div')].find(el => el.style.touchAction === 'none' && el.getBoundingClientRect().width > 100);
      if (!layer) throw new Error('No simulator stream');
      const r = layer.getBoundingClientRect();
      return { x: r.x + r.width / 2, y: r.y + r.height / 2 };
    })()`,
      frame,
    );
    // The page gets the drag, as from Finder, and Chrome routes it into the frame.
    const offset = frame
      ? await browser.cdp.evaluate<{ x: number; y: number }>(
          "(() => { const r = document.querySelector('iframe').getBoundingClientRect(); return { x: r.x, y: r.y }; })()",
        )
      : { x: 0, y: 0 };
    for (const type of ["dragEnter", "dragOver", "drop"]) {
      await browser.cdp.send("Input.dispatchDragEvent", {
        type,
        x: point.x + offset.x,
        y: point.y + offset.y,
        data: { items: [], files: paths, dragOperationsMask: 1 },
      });
      if (type === "dragOver") {
        await until(
          () =>
            browser.cdp.evaluate<boolean>(
              "document.body.textContent.includes('Drop media or a Simulator app')",
              frame,
            ),
          "Preview did not show the Simulator app drop label",
        );
        const screenshot = process.env.SERVE_SIM_DROP_SCREENSHOT;
        if (screenshot) {
          const result = await browser.cdp.send("Page.captureScreenshot", { format: "png" });
          writeFileSync(screenshot, Buffer.from(result.data as string, "base64"));
        }
      }
    }
  }

  async function removedUpload(): Promise<void> {
    await until(
      () =>
        sent.some(
          ({ id, action }) => action === "upload.remove" && replies.get(id)?.exitCode === 0,
        ),
      "Dropped upload was not removed",
    );
    const staging = join(env.TMPDIR!, "serve-sim-uploads");
    const files = readdirSync(staging, { recursive: true }).filter((name) =>
      /serve-sim-(upload|install)-/.test(String(name)),
    );
    expect(files).toEqual([]);
  }

  // A 91–100 byte archive path exercises macOS tar's PAX-header prefix.
  const ASSET = `assets/${"x".repeat(72)}.txt`;

  /** A signed copy of the fixture app, with an asset, that is not installed yet. */
  function appBundle(folder: string): string {
    try {
      simctl("uninstall", udid!, APP);
    } catch {
      /* It may not be installed. */
    }
    const bundle = join(root, folder);
    cpSync(FIXTURE, bundle, { recursive: true });
    mkdirSync(join(bundle, "assets"), { recursive: true });
    writeFileSync(join(bundle, ASSET), "archive asset");
    execFileSync("plutil", [
      "-replace",
      "CFBundleIdentifier",
      "-string",
      APP,
      join(bundle, "Info.plist"),
    ]);
    execFileSync("codesign", ["--force", "--sign", "-", "--timestamp=none", bundle], {
      stdio: "pipe",
    });
    return bundle;
  }

  /** Checks the install reply, the success toast, the installed files and a launch. */
  async function expectInstalled(name: string, frame?: string) {
    await until(
      () => sent.some(({ id, action }) => action === "app.install" && replies.has(id)),
      "Archive drop did not reach app.install",
    );
    const request = sent.find((message) => message.action === "app.install")!;
    expect(replies.get(request.id)?.exitCode, replies.get(request.id)?.stderr).toBe(0);
    await until(
      () =>
        browser.cdp.evaluate<boolean>(
          `document.body.textContent.includes(${JSON.stringify("Installed ")} + ${JSON.stringify(name)})`,
          frame,
        ),
      "Preview did not report installation",
    );
    await removedUpload();
    const installed = simctl("get_app_container", udid!, APP, "app").trim();
    expect(readFileSync(join(installed, ASSET), "utf8")).toBe("archive asset");
    const container = simctl("get_app_container", udid!, APP, "data").trim();
    simctl("launch", udid!, APP, "-DropE2E", name);
    await until(() => {
      try {
        return readFileSync(join(container, "Documents/launches.tsv"), "utf8").includes(name);
      } catch {
        return false;
      }
    }, "Installed app did not launch with the test argument");
    simctl("terminate", udid!, APP);
  }

  beforeAll(async () => {
    // Imported Photos data leaves with this suite-owned device; the pinned device stays unchanged.
    const devices = JSON.parse(simctl("list", "devices", "-j")) as {
      devices: Record<string, Array<{ udid: string; deviceTypeIdentifier: string }>>;
    };
    const runtime = Object.entries(devices.devices).find(([, values]) =>
      values.some((device) => device.udid === sourceUdid),
    );
    const model = runtime?.[1].find((device) => device.udid === sourceUdid)?.deviceTypeIdentifier;
    if (!runtime || !model)
      throw new Error("Cannot determine the pinned Simulator's runtime and model");
    udid = simctl(
      "create",
      `serve-sim-preview-drop-${process.pid}-${Date.now()}`,
      model,
      runtime[0],
    ).trim();
    console.info(`[drop-e2e] Owned simulator ${udid}; runtime ${runtime[0]}; source ${sourceUdid}`);
    simctl("boot", udid);
    execFileSync("xcrun", ["simctl", "bootstatus", udid, "-b"], { timeout: 120000, stdio: "pipe" });
    root = mkdtempSync(join(tmpdir(), "serve-sim-preview-drop-"));
    mkdirSync(join(root, "tmp"));
    env = {
      ...process.env,
      TMPDIR: join(root, "tmp"),
      SERVE_SIM_STATE_DIR: join(root, "state"),
      SERVE_SIM_ACTION_TIMEOUT_MS: "120000",
    };
    const port = await freePortAsync();
    const started = spawnSync("node", [CLI, "--detach", "-p", String(port), udid!], {
      env,
      encoding: "utf8",
      timeout: 120000,
    });
    if (started.status !== 0) throw new Error(`Preview startup failed: ${started.stderr}`);
    const state = parseDetachState<ServeSimDeviceState>(started.stdout);
    previewUrl = state.url;
    browser = await startTestBrowser();
    browser.cdp.onEvent = (method, params) => {
      if (method === "Target.attachedToTarget") {
        const target = params.targetInfo as { type: string; url: string };
        if (target.type === "worker") workers.push(target.url);
        return;
      }
      if (method !== "Network.webSocketFrameSent" && method !== "Network.webSocketFrameReceived")
        return;
      const response = params.response as { payloadData: string; opcode: number };
      if (response.opcode !== 1) return;
      try {
        const message = JSON.parse(response.payloadData);
        if (
          method.endsWith("Sent") &&
          typeof message.action === "string" &&
          /^(upload\.|media\.add$|app\.install$)/.test(message.action)
        )
          sent.push(message);
        if (method.endsWith("Received") && typeof message.id === "number")
          replies.set(message.id, message);
      } catch {
        /* Binary/video frames are outside this assertion. */
      }
    };
    await browser.cdp.send("Network.enable");
    await browser.cdp.send("Page.navigate", { url: state.url });
    await until(
      () =>
        browser.cdp.evaluate<boolean>(
          `document.querySelector('[aria-label="Rotate device"]')?.disabled === false`,
        ),
      "Preview did not enable streamed-device controls",
      60000,
    );
  }, 180000);

  afterAll(async () => {
    try {
      await browser?.close();
    } finally {
      try {
        if (env && udid)
          spawnSync("node", [CLI, "--kill", udid], { env, timeout: 30000, stdio: "ignore" });
        if (udid) {
          try {
            simctl("shutdown", udid);
          } catch {
            /* Boot can fail during setup. */
          }
          simctl("delete", udid);
          console.info(`[drop-e2e] Deleted simulator ${udid}`);
        }
      } finally {
        if (root) rmSync(root, { recursive: true, force: true });
      }
    }
  }, 60000);

  test("a device IPA shows Simulator-build guidance without uploading", async () => {
    await drop([
      {
        name: "device-build.ipa",
        bytes: Buffer.from("reject this file before reading its contents"),
      },
    ]);
    await until(
      () =>
        browser.cdp.evaluate<boolean>(
          "[...document.querySelectorAll('[data-testid=upload-toast]')].some(el => el.textContent.includes('Cannot install device-build.ipa'))",
        ),
      "Preview did not report the unsupported IPA",
    );
    const message = await browser.cdp.evaluate<string>(
      "[...document.querySelectorAll('[data-testid=upload-toast]')].find(el => el.textContent.includes('Cannot install device-build.ipa'))?.textContent ?? ''",
    );
    expect(message).toContain(
      "This is a device build. Drop a Simulator .app folder or a .tar.gz archive.",
    );
    expect(sent).toEqual([]);
    const errorStyle = await browser.cdp.evaluate<string>(
      "getComputedStyle(document.querySelector('[data-testid=upload-toast] p')).whiteSpace",
    );
    expect(errorStyle).toBe("normal");
    // The guidance must still be readable after the old three-second dismissal.
    await Bun.sleep(3200);
    expect(
      await browser.cdp.evaluate<boolean>(
        "!!document.querySelector('[aria-label=\"Dismiss upload error\"]')",
      ),
    ).toBe(true);
    const screenshot = process.env.SERVE_SIM_DROP_ERROR_SCREENSHOT;
    if (screenshot) {
      const result = await browser.cdp.send("Page.captureScreenshot", { format: "png" });
      writeFileSync(screenshot, Buffer.from(result.data as string, "base64"));
    }
  }, 60000);

  test("a PNG reaches Photos and its staged upload is removed", async () => {
    const before = photoCount();
    const name = `browser-photo-${crypto.randomUUID()}.png`;
    await drop([{ name, bytes: PNG }]);
    // A fresh Photos library can initialize slowly. Wait beyond the host's 120s
    // action deadline so a test retry cannot overlap an unfinished import.
    await until(
      () => sent.some(({ id, action }) => action === "media.add" && replies.has(id)),
      "Media import did not complete",
      130000,
    );
    const request = sent.find((message) => message.action === "media.add")!;
    expect(replies.get(request.id)?.exitCode, replies.get(request.id)?.stderr).toBe(0);
    await until(
      () =>
        browser.cdp.evaluate<boolean>(
          `document.body.textContent.includes(${JSON.stringify(`Added ${name} to Photos`)})`,
        ),
      "Preview did not report media success",
    );
    await until(() => photoCount() === before + 1, "Dropped PNG did not reach Simulator Photos");
    expect(sent.some((message) => message.action === "media.add")).toBe(true);
    await removedUpload();
  }, 240000);

  test("a failed media import reports its error and removes the upload", async () => {
    const before = photoCount();
    await drop([{ name: "invalid-photo.png", bytes: Buffer.from("not an image") }]);
    await until(
      () => sent.some(({ id, action }) => action === "media.add" && replies.has(id)),
      "Media request did not complete",
    );
    const request = sent.find((message) => message.action === "media.add")!;
    expect(replies.get(request.id)?.exitCode).not.toBe(0);
    await until(
      () =>
        browser.cdp.evaluate<boolean>(
          "[...document.querySelectorAll('[data-testid=upload-toast]')].some(el => el.textContent.includes('Could not add invalid-photo.png to Photos'))",
        ),
      "Preview hid the media error",
    );
    expect(photoCount()).toBe(before);
    await removedUpload();
  }, 60000);

  requireE2E("preview app archive drops (requires app fixture)", fixtureReady);
  test.skipIf(!fixtureReady).each(["browser-app.tar.gz", "browser-app.tgz", "Browser.app"])(
    "%s installs and launches the app through the preview",
    async (name) => {
      const folder = name.endsWith(".tgz") ? "Café.app" : "Browser.app";
      const bundle = appBundle(folder);
      if (name.endsWith(".app")) {
        await dropPaths([bundle]);
      } else {
        const archive = join(root, name);
        if (name.endsWith(".tgz")) {
          // The CLI/EAS node-tar producer emits PAX headers for Unicode paths.
          await createTar({ cwd: root, gzip: true, file: archive }, [folder]);
        } else {
          execFileSync("tar", ["-czf", archive, "-C", root, folder]);
        }
        await drop([{ name, bytes: readFileSync(archive) }]);
      }
      await expectInstalled(name);
    },
    90000,
  );

  // expo.dev frames the preview from another site, with these iframe attributes.
  test.skipIf(!fixtureReady)(
    "an .app folder dropped on a preview framed by another site installs through the Worker",
    async () => {
      const bundle = appBundle("Framed.app");
      // localhost and 127.0.0.1 are different sites, so Chrome runs the frame in its own process.
      const preview = new URL(previewUrl);
      preview.hostname = "localhost";
      const parent = Bun.serve({
        port: 0,
        hostname: "127.0.0.1",
        fetch: () =>
          new Response(
            `<!doctype html><body style="margin:0"><iframe src="${preview.href}" title="Expo Simulators preview" referrerpolicy="no-referrer" sandbox="allow-scripts allow-same-origin allow-forms allow-popups allow-downloads" allow="clipboard-write; fullscreen" style="display:block;width:100vw;height:100vh;border:0"></iframe></body>`,
            { headers: { "content-type": "text/html" } },
          ),
      });
      try {
        const { cdp } = browser;
        await cdp.send("Target.setAutoAttach", {
          autoAttach: true,
          waitForDebuggerOnStart: true,
          flatten: true,
        });
        const framesBefore = cdp.frameSessions.length;
        await cdp.send("Page.navigate", { url: `http://127.0.0.1:${parent.port}/` });
        await until(
          () => cdp.frameSessions.length > framesBefore,
          "Chrome did not attach to the cross-site preview frame",
        );
        const frame = cdp.frameSessions.at(-1)!;
        // The frame waits for the debugger, so these also see its first socket and its Worker.
        await cdp.send("Network.enable", {}, frame);
        await cdp.send(
          "Target.setAutoAttach",
          { autoAttach: true, waitForDebuggerOnStart: false, flatten: true },
          frame,
        );
        await cdp.send("Runtime.runIfWaitingForDebugger", {}, frame);
        await until(
          () =>
            cdp.evaluate<boolean>(
              `document.querySelector('[aria-label="Rotate device"]')?.disabled === false`,
              frame,
            ),
          "Framed preview did not enable streamed-device controls",
          60000,
        );
        workers.length = 0;
        await dropPaths([bundle], frame);
        await expectInstalled("Framed.app", frame);
        // The packer ran as a Worker from a blob: URL with the frame's own origin.
        expect(
          workers.some((url) => url.startsWith(`blob:${preview.origin}/`)),
          JSON.stringify(workers),
        ).toBe(true);
      } finally {
        parent.stop(true);
      }
    },
    120000,
  );
});
