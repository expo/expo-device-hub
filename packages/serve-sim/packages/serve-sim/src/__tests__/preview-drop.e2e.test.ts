import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { execFileSync, spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { CHROME, startTestBrowser } from "./browser-e2e";
import { parseDetachState } from "./detach-state";
import { e2eDevice, requireE2E } from "./e2e-preconditions";
import { freePortAsync } from "./helpers";
import type { ServeSimDeviceState } from "../state";

const CLI = join(import.meta.dir, "../../dist/serve-sim.js");
const udid = e2eDevice();
const ready = udid !== null && existsSync(CLI) && existsSync(CHROME);
requireE2E("preview file drops (requires Chrome)", ready);
const PNG = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jRz0AAAAASUVORK5CYII=",
  "base64",
);

describe.skipIf(!ready)("preview file drops through the real action channel", () => {
  let root: string;
  let env: NodeJS.ProcessEnv;
  let browser: Awaited<ReturnType<typeof startTestBrowser>>;
  const sent: Array<{ id: number; action: string; params: Record<string, unknown> }> = [];
  const replies = new Map<number, { exitCode?: number; stderr?: string }>();

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
    const body = browser ? await browser.cdp.evaluate<string>("document.body.innerText") : "";
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
    sent.length = 0;
    replies.clear();
    const paths = files.map(({ name, bytes }) => {
      const path = join(root, name);
      writeFileSync(path, bytes);
      return path;
    });
    const point = await browser.cdp.evaluate<{ x: number; y: number }>(`(() => {
      const layer = [...document.querySelectorAll('div')].find(el => el.style.touchAction === 'none' && el.getBoundingClientRect().width > 100);
      if (!layer) throw new Error('No simulator stream');
      const r = layer.getBoundingClientRect();
      return { x: r.x + r.width / 2, y: r.y + r.height / 2 };
    })()`);
    for (const type of ["dragEnter", "dragOver", "drop"]) {
      await browser.cdp.send("Input.dispatchDragEvent", {
        type,
        ...point,
        data: { items: [], files: paths, dragOperationsMask: 1 },
      });
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

  beforeAll(async () => {
    root = mkdtempSync(join(tmpdir(), "serve-sim-preview-drop-"));
    mkdirSync(join(root, "tmp"));
    env = { ...process.env, TMPDIR: join(root, "tmp"), SERVE_SIM_STATE_DIR: join(root, "state") };
    const port = await freePortAsync();
    const started = spawnSync("node", [CLI, "--detach", "-p", String(port), udid!], {
      env,
      encoding: "utf8",
      timeout: 120000,
    });
    if (started.status !== 0) throw new Error(`Preview startup failed: ${started.stderr}`);
    const state = parseDetachState<ServeSimDeviceState>(started.stdout);
    browser = await startTestBrowser();
    browser.cdp.onEvent = (method, params) => {
      if (method !== "Network.webSocketFrameSent" && method !== "Network.webSocketFrameReceived")
        return;
      const response = params.response as { payloadData: string; opcode: number };
      if (response.opcode !== 1) return;
      try {
        const message = JSON.parse(response.payloadData);
        if (method.endsWith("Sent") && typeof message.action === "string") sent.push(message);
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
      if (env) spawnSync("node", [CLI, "--kill", udid!], { env, timeout: 30000, stdio: "ignore" });
      if (root) rmSync(root, { recursive: true, force: true });
    }
  }, 60000);

  test("a PNG reaches Photos and its staged upload is removed", async () => {
    const before = photoCount();
    await drop([{ name: "browser-photo.png", bytes: PNG }]);
    await until(
      () =>
        browser.cdp.evaluate<boolean>(
          "document.body.textContent.includes('Added browser-photo.png to Photos')",
        ),
      "Preview did not report media success",
    );
    await until(() => photoCount() === before + 1, "Dropped PNG did not reach Simulator Photos");
    expect(sent.some((message) => message.action === "media.add")).toBe(true);
    await removedUpload();
  }, 60000);

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
          "[...document.querySelectorAll('[data-testid=upload-toast]')].some(el => el.textContent.includes('invalid-photo.png:'))",
        ),
      "Preview hid the media error",
    );
    expect(photoCount()).toBe(before);
    await removedUpload();
  }, 60000);
});
