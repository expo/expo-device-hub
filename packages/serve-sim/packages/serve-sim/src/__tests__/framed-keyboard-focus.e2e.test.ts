import { e2eDevice, requireE2E } from "./e2e-preconditions";
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { execFileSync, spawn, spawnSync, type ChildProcess } from "child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { parseDetachState } from "./detach-state";
import { freePortAsync } from "./helpers";
import type { ServeSimDeviceState } from "../state";

const CLI_PATH = join(import.meta.dir, "../../dist/serve-sim.js");
const FIXTURE = join(import.meta.dir, "../../dist/capability-loader/ServeSimLaunchFixture.app");
const APP = "dev.expo.serve-sim.launch-fixture";
const CHROME = process.env.SERVE_SIM_CHROME ?? "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome";

const udid = e2eDevice();
const ready = udid !== null && existsSync(CLI_PATH) && existsSync(FIXTURE) && existsSync(CHROME);
requireE2E(`framed keyboard focus (needs Chrome at ${CHROME}; set SERVE_SIM_CHROME to use another)`, ready);
const describeWithSim = ready ? describe : describe.skip;

function cli(...args: string[]): string {
  return execFileSync("node", [CLI_PATH, ...args], { encoding: "utf8", timeout: 15_000 });
}

function simctl(...args: string[]): string {
  return execFileSync("xcrun", ["simctl", ...args], { encoding: "utf8", stdio: "pipe", timeout: 30_000 });
}

class Cdp {
  private nextId = 0;
  private pending = new Map<number, (result: Record<string, unknown>) => void>();
  readonly frameSessions: string[] = [];

  private constructor(private readonly ws: WebSocket) {
    ws.onmessage = (event) => {
      const message = JSON.parse(String(event.data)) as {
        id?: number;
        method?: string;
        params?: { sessionId?: string; targetInfo?: { type?: string } };
        result?: Record<string, unknown>;
      };
      if (message.id !== undefined) this.pending.get(message.id)?.(message.result ?? {});
      if (message.method === "Target.attachedToTarget" && message.params?.targetInfo?.type === "iframe") {
        this.frameSessions.push(message.params.sessionId!);
      }
    };
  }

  static async connect(url: string): Promise<Cdp> {
    const ws = new WebSocket(url);
    await new Promise<void>((resolve, reject) => {
      ws.onopen = () => resolve();
      ws.onerror = () => reject(new Error(`CDP connection failed: ${url}`));
    });
    return new Cdp(ws);
  }

  send(method: string, params: object = {}, sessionId?: string): Promise<Record<string, unknown>> {
    const id = ++this.nextId;
    return new Promise((resolve) => {
      this.pending.set(id, resolve);
      this.ws.send(JSON.stringify({ id, method, params, sessionId }));
    });
  }

  async evaluate<T>(expression: string, sessionId?: string): Promise<T> {
    const reply = await this.send("Runtime.evaluate", { expression, returnByValue: true }, sessionId);
    return (reply.result as { value: T }).value;
  }

  close(): void {
    this.ws.close();
  }
}

const STREAM_LAYER = `[...document.querySelectorAll("div")].find((d) => d.style.touchAction === "none" && d.getBoundingClientRect().width > 100)`;
const HARDWARE_KEYBOARD_SWITCH = `document.querySelector('[role="switch"][aria-label="Hardware Keyboard"]')`;
const TOOLS_BUTTON = `document.querySelector('[aria-label="Open tools panel"]')`;

describeWithSim(`desktop keyboard focus (sim ${udid ?? "<skipped>"})`, () => {
  let state: ServeSimDeviceState;
  let fixtureLog: string;
  let chrome: ChildProcess;
  let profile: string;
  let cdp: Cdp;
  let parent: ReturnType<typeof Bun.serve>;
  let simUrl: string;

  function fixtureLines(): string[] {
    try { return readFileSync(fixtureLog, "utf8").split("\n").filter(Boolean); }
    catch { return []; }
  }

  async function waitFor<T>(read: () => T, expected: T, timeoutMs = 10_000): Promise<void> {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      if (read() === expected) return;
      await Bun.sleep(100);
    }
    expect(read()).toBe(expected);
  }

  async function launchTextField(): Promise<number> {
    const start = fixtureLines().length;
    try { simctl("terminate", udid!, APP); } catch {}
    simctl("launch", udid!, APP, "--keyboard-test");
    await waitFor(() => fixtureLines().slice(start).some((line) => line.startsWith("keyboard-ready\t")), true);
    return start;
  }

  function lastText(start: number): string | undefined {
    return fixtureLines().slice(start).filter((line) => line.startsWith("text\t")).at(-1)?.split("\t")[2];
  }

  async function load(url: string): Promise<string | undefined> {
    const framesBefore = cdp.frameSessions.length;
    await cdp.send("Page.navigate", { url });
    const deadline = Date.now() + 30_000;
    while (Date.now() < deadline) {
      if (await cdp.evaluate<boolean>("document.readyState === 'complete'")) break;
      await Bun.sleep(200);
    }
    return cdp.frameSessions.slice(framesBefore).at(-1);
  }

  async function elementCenter(expression: string, sessionId?: string, yFraction = 0.5): Promise<{ x: number; y: number } | null> {
    const rect = await cdp.evaluate<{ x: number; y: number; width: number; height: number } | null>(
      `(() => { const el = ${expression}; if (!el) return null; const r = el.getBoundingClientRect(); return { x: r.x, y: r.y, width: r.width, height: r.height }; })()`,
      sessionId,
    );
    return rect ? { x: rect.x + rect.width / 2, y: rect.y + rect.height * yFraction } : null;
  }

  async function waitForElement(expression: string, sessionId?: string, yFraction = 0.5): Promise<{ x: number; y: number }> {
    const deadline = Date.now() + 30_000;
    while (Date.now() < deadline) {
      const point = await elementCenter(expression, sessionId, yFraction);
      if (point) return point;
      await Bun.sleep(200);
    }
    throw new Error(`No element matched ${expression} within 30s.`);
  }

  async function openFramed(): Promise<string> {
    const session = await load(`http://127.0.0.1:${parent.port}/`);
    if (!session) throw new Error("Chrome did not attach to the cross-origin preview frame.");
    await cdp.send("Runtime.enable", {}, session);
    await cdp.send("Runtime.runIfWaitingForDebugger", {}, session);
    return session;
  }

  async function clickOnce(point: { x: number; y: number }): Promise<void> {
    await cdp.send("Input.dispatchMouseEvent", { type: "mouseMoved", ...point });
    await cdp.send("Input.dispatchMouseEvent", { type: "mousePressed", ...point, button: "left", buttons: 1, clickCount: 1 });
    await cdp.send("Input.dispatchMouseEvent", { type: "mouseReleased", ...point, button: "left", buttons: 0, clickCount: 1 });
  }

  async function typeKeys(text: string): Promise<void> {
    for (const key of text) {
      const code = `Key${key.toUpperCase()}`;
      const windowsVirtualKeyCode = key.toUpperCase().charCodeAt(0);
      await cdp.send("Input.dispatchKeyEvent", { type: "keyDown", code, key, text: key, windowsVirtualKeyCode });
      await cdp.send("Input.dispatchKeyEvent", { type: "keyUp", code, key, windowsVirtualKeyCode });
      await Bun.sleep(50);
    }
  }

  beforeAll(async () => {
    try { cli("--kill", udid!); } catch {}
    try { simctl("uninstall", udid!, APP); } catch {}
    simctl("install", udid!, FIXTURE);
    fixtureLog = join(simctl("get_app_container", udid!, APP, "data").trim(), "Documents/launches.tsv");

    const port = await freePortAsync();
    const detach = spawnSync("node", [CLI_PATH, "--detach", "-p", String(port), udid!], {
      encoding: "utf-8",
      stdio: ["ignore", "pipe", "inherit"],
      timeout: 120_000,
    });
    if (detach.status !== 0 || !detach.stdout) {
      throw new Error(`serve-sim --detach failed (exit=${detach.status} signal=${detach.signal})\nstdout: ${detach.stdout}`);
    }
    state = parseDetachState<ServeSimDeviceState>(detach.stdout);
    simUrl = state.url.replace("127.0.0.1", "localhost");
    parent = Bun.serve({
      port: 0,
      hostname: "127.0.0.1",
      fetch: () => new Response(
        `<!doctype html><body style="margin:0"><iframe src="${simUrl}" style="width:100vw;height:100vh;border:0" sandbox="allow-scripts allow-same-origin allow-forms allow-popups allow-downloads" allow="clipboard-write; fullscreen"></iframe></body>`,
        { headers: { "content-type": "text/html" } },
      ),
    });

    profile = mkdtempSync(join(tmpdir(), "serve-sim-chrome-"));
    chrome = spawn(CHROME, [
      "--headless=new", "--remote-debugging-port=0", `--user-data-dir=${profile}`,
      "--window-size=1200,900", "--no-first-run", "about:blank",
    ], { stdio: ["ignore", "ignore", "pipe"] });
    const browserUrl = await new Promise<string>((resolve, reject) => {
      let output = "";
      chrome.stderr!.on("data", (chunk) => {
        output += chunk;
        const match = output.match(/ws:\/\/\S+/);
        if (match) resolve(match[0]);
      });
      chrome.on("exit", (code) => reject(new Error(`Chrome exited before it opened a debugging port (exit=${code}).\n${output}`)));
    });
    let pageUrl: string | undefined;
    const deadline = Date.now() + 15_000;
    while (!pageUrl && Date.now() < deadline) {
      const targets = await (await fetch(`http://127.0.0.1:${new URL(browserUrl).port}/json/list`)).json() as Array<{ type: string; webSocketDebuggerUrl: string }>;
      pageUrl = targets.find((target) => target.type === "page")?.webSocketDebuggerUrl;
      if (!pageUrl) await Bun.sleep(100);
    }
    if (!pageUrl) throw new Error(`Chrome opened a debugging port but no page within 15s. Check that ${CHROME} starts headless on this machine.`);
    cdp = await Cdp.connect(pageUrl);
    await cdp.send("Page.enable");
    await cdp.send("Target.setAutoAttach", { autoAttach: true, waitForDebuggerOnStart: false, flatten: true });
  }, 180_000);

  afterAll(() => {
    try { cli("ui", "hardware-keyboard", "on", "-d", udid!); } catch {}
    cdp?.close();
    chrome?.kill();
    parent?.stop(true);
    if (profile) rmSync(profile, { recursive: true, force: true });
    try { cli("--kill", udid!); } catch {}
    try { simctl("terminate", udid!, APP); } catch {}
    try { simctl("uninstall", udid!, APP); } catch {}
  }, 60_000);

  test("one click on the stream lets the keyboard type into the simulator", async () => {
    await load(simUrl);
    const stream = await waitForElement(STREAM_LAYER, undefined, 0.75);
    const start = await launchTextField();
    await clickOnce(stream);
    await typeKeys("zq");
    await waitFor(() => lastText(start), "zq");
  }, 90_000);

  test("one click on the stream lets the keyboard type when framed by another origin", async () => {
    const frame = await openFramed();
    const stream = await waitForElement(STREAM_LAYER, frame, 0.75);
    const start = await launchTextField();
    await clickOnce(stream);
    await typeKeys("zq");
    await waitFor(() => lastText(start), "zq");
  }, 90_000);

  test("the keyboard still types after switching the hardware keyboard in the tools panel", async () => {
    const frame = await openFramed();
    const stream = await waitForElement(STREAM_LAYER, frame, 0.75);
    const start = await launchTextField();
    await clickOnce(stream);
    await typeKeys("zq");
    await waitFor(() => lastText(start), "zq");

    if (!await elementCenter(HARDWARE_KEYBOARD_SWITCH, frame)) {
      await clickOnce(await waitForElement(TOOLS_BUTTON, frame));
    }
    const hardwareKeyboard = await waitForElement(HARDWARE_KEYBOARD_SWITCH, frame);
    await clickOnce(hardwareKeyboard);
    const deadline = Date.now() + 10_000;
    while (Date.now() < deadline && await cdp.evaluate<string>(`${HARDWARE_KEYBOARD_SWITCH}.getAttribute("aria-checked")`, frame) !== "false") {
      await Bun.sleep(100);
    }
    expect(await cdp.evaluate<string>(`${HARDWARE_KEYBOARD_SWITCH}.getAttribute("aria-checked")`, frame)).toBe("false");

    await clickOnce(stream);
    await typeKeys("xy");
    await waitFor(() => lastText(start), "zqxy");

    await clickOnce(hardwareKeyboard);
    await clickOnce(stream);
    await typeKeys("w");
    await waitFor(() => lastText(start), "zqxyw");
  }, 90_000);
});
