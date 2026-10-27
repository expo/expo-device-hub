import { spawn, type ChildProcess } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

export const CHROME =
  process.env.SERVE_SIM_CHROME ?? "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome";

export class Cdp {
  private nextId = 0;
  private pending = new Map<
    number,
    {
      resolve(result: Record<string, unknown>): void;
      reject(error: Error): void;
      timer: ReturnType<typeof setTimeout>;
    }
  >();
  readonly frameSessions: string[] = [];
  onEvent?: (method: string, params: Record<string, unknown>) => void;

  private constructor(private readonly ws: WebSocket) {
    ws.onmessage = (event) => {
      const message = JSON.parse(String(event.data)) as {
        id?: number;
        method?: string;
        params?: { sessionId?: string; targetInfo?: { type?: string } };
        result?: Record<string, unknown>;
        error?: { message: string };
      };
      if (message.method) this.onEvent?.(message.method, message.params ?? {});
      if (message.id !== undefined) {
        const pending = this.pending.get(message.id);
        if (pending) {
          this.pending.delete(message.id);
          clearTimeout(pending.timer);
          if (message.error) pending.reject(new Error(message.error.message));
          else pending.resolve(message.result ?? {});
        }
      }
      if (
        message.method === "Target.attachedToTarget" &&
        message.params?.targetInfo?.type === "iframe"
      ) {
        this.frameSessions.push(message.params.sessionId!);
      }
    };
  }

  static async connect(url: string): Promise<Cdp> {
    const ws = new WebSocket(url);
    await new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => {
        ws.close();
        reject(new Error("CDP connection timed out"));
      }, 15000);
      ws.onopen = () => {
        clearTimeout(timer);
        resolve();
      };
      ws.onerror = () => {
        clearTimeout(timer);
        reject(new Error(`CDP connection failed: ${url}`));
      };
    });
    return new Cdp(ws);
  }

  send(method: string, params: object = {}, sessionId?: string): Promise<Record<string, unknown>> {
    const id = ++this.nextId;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`CDP ${method} timed out`));
      }, 15000);
      this.pending.set(id, { resolve, reject, timer });
      this.ws.send(JSON.stringify({ id, method, params, sessionId }));
    });
  }

  async evaluate<T>(expression: string, sessionId?: string): Promise<T> {
    const reply = await this.send(
      "Runtime.evaluate",
      { expression, returnByValue: true, awaitPromise: true },
      sessionId,
    );
    if (reply.exceptionDetails) throw new Error(JSON.stringify(reply.exceptionDetails));
    return (reply.result as { value: T }).value;
  }

  close(): void {
    for (const pending of this.pending.values()) {
      clearTimeout(pending.timer);
      pending.reject(new Error("CDP connection closed"));
    }
    this.pending.clear();
    this.ws.close();
  }
}

class ChromeStartupTimeout extends Error {}

/** Retry a stalled launch once, after removing its process and private profile. */
export async function startTestBrowser(startupTimeoutMs = 15000) {
  try {
    return await startBrowserAttempt(startupTimeoutMs);
  } catch (error) {
    if (!(error instanceof ChromeStartupTimeout)) throw error;
    return await startBrowserAttempt(startupTimeoutMs);
  }
}

/** Each test owns its Chrome profile and process; never attach to a user's browser. */
async function startBrowserAttempt(
  startupTimeoutMs: number,
): Promise<{ cdp: Cdp; close(): Promise<void> }> {
  const profile = mkdtempSync(join(tmpdir(), "serve-sim-chrome-"));
  let chrome: ChildProcess | undefined;
  let cdp: Cdp | undefined;
  const close = async () => {
    cdp?.close();
    if (chrome?.pid && chrome.exitCode === null && chrome.signalCode === null) {
      const exited = new Promise<void>((resolve) => chrome!.once("exit", () => resolve()));
      chrome.kill();
      const timer = setTimeout(() => chrome?.kill("SIGKILL"), 3000);
      await exited;
      clearTimeout(timer);
    }
    rmSync(profile, { recursive: true, force: true });
  };
  try {
    chrome = spawn(
      CHROME,
      [
        "--headless=new",
        "--remote-debugging-port=0",
        `--user-data-dir=${profile}`,
        "--window-size=1200,900",
        "--no-first-run",
        "about:blank",
      ],
      { stdio: ["ignore", "ignore", "pipe"] },
    );
    const browserUrl = await new Promise<string>((resolve, reject) => {
      let output = "";
      const timer = setTimeout(
        () =>
          reject(
            new ChromeStartupTimeout(
              `Chrome did not open a debugging port within ${startupTimeoutMs}ms: ${output || "(no stderr)"}`,
            ),
          ),
        startupTimeoutMs,
      );
      chrome!.stderr!.on("data", (chunk) => {
        output = (output + chunk).slice(-8192);
        const match = output.match(/ws:\/\/\S+/);
        if (match) {
          clearTimeout(timer);
          resolve(match[0]);
        }
      });
      chrome!.once("error", (error) => {
        clearTimeout(timer);
        reject(error);
      });
      chrome!.once("exit", (code) => {
        clearTimeout(timer);
        reject(new Error(`Chrome exited (${code}): ${output}`));
      });
    });
    let pageUrl: string | undefined;
    let discoveryError: unknown;
    const deadline = Date.now() + 15000;
    while (!pageUrl && Date.now() < deadline) {
      try {
        const response = await fetch(`http://127.0.0.1:${new URL(browserUrl).port}/json/list`, {
          signal: AbortSignal.timeout(Math.min(5000, deadline - Date.now())),
        });
        if (!response.ok)
          throw new Error(`Chrome target discovery returned HTTP ${response.status}`);
        const targets = (await response.json()) as Array<{
          type: string;
          webSocketDebuggerUrl: string;
        }>;
        pageUrl = targets.find((target) => target.type === "page")?.webSocketDebuggerUrl;
      } catch (error) {
        // The debugging socket can be announced before HTTP discovery is ready.
        // Retry transient requests within the existing total startup budget.
        discoveryError = error;
      }
      if (!pageUrl) await Bun.sleep(100);
    }
    if (!pageUrl)
      throw new Error("Chrome opened no page target within 15 seconds", { cause: discoveryError });
    cdp = await Cdp.connect(pageUrl);
    await cdp.send("Page.enable");
    return { cdp, close };
  } catch (error) {
    await close();
    throw error;
  }
}
