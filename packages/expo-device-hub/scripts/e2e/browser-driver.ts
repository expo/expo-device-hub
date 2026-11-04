import { spawn, type ChildProcess } from "node:child_process";
import { access } from "node:fs/promises";
import { join } from "node:path";
import { setTimeout as pause } from "node:timers/promises";

/** Matches the existing serve-sim browser E2E convention, without a new runner dependency. */
export async function openBrowser(url: string, directory: string) {
  const executable =
    process.env.HUB_E2E_BROWSER ?? "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome";
  await access(executable).catch(() => {
    throw new Error(
      `Browser unavailable: ${executable}. Set HUB_E2E_BROWSER or use --interactive.`,
    );
  });
  const child: ChildProcess = spawn(
    executable,
    [
      "--headless=new",
      "--remote-debugging-port=0",
      "--remote-allow-origins=*",
      "--no-first-run",
      "--no-default-browser-check",
      "--autoplay-policy=no-user-gesture-required",
      `--user-data-dir=${join(directory, "browser")}`,
      "about:blank",
    ],
    { stdio: ["ignore", "ignore", "pipe"] },
  );
  let output = "";
  child.stderr?.on("data", (chunk) => {
    output = (output + chunk.toString()).slice(-32_768);
  });
  let browserError: Error | undefined;
  child.on("error", (error) => {
    browserError = error;
  });
  async function stopBrowser() {
    if (!child.pid || child.exitCode !== null || child.signalCode !== null) return;
    const exited = new Promise<void>((done) => child.once("exit", () => done()));
    child.kill("SIGTERM");
    await Promise.race([exited, pause(5_000)]);
    if (child.exitCode === null && child.signalCode === null) {
      child.kill("SIGKILL");
      await exited;
    }
  }
  let socket: WebSocket | undefined;
  try {
    const started = Date.now();
    let endpoint: string | undefined;
    while (!endpoint && Date.now() - started < 15_000) {
      if (browserError) throw browserError;
      if (child.exitCode !== null || child.signalCode !== null)
        throw new Error(`Browser exited: ${output}`);
      endpoint = output.match(/DevTools listening on (ws:\/\/[^\s]+)/)?.[1];
      await pause(100);
    }
    if (!endpoint) throw new Error(`Browser debugger did not start: ${output}`);
    socket = new WebSocket(endpoint);
    await new Promise<void>((resolve, reject) => {
      const timer = setTimeout(
        () => reject(new Error("Browser debugger connection timed out")),
        10_000,
      );
      socket!.onopen = () => {
        clearTimeout(timer);
        resolve();
      };
      socket!.onerror = () => {
        clearTimeout(timer);
        reject(new Error("Browser debugger connection failed"));
      };
    });
    let nextId = 0;
    const pending = new Map<
      number,
      {
        resolve: (value: any) => void;
        reject: (error: Error) => void;
        timer: ReturnType<typeof setTimeout>;
      }
    >();
    socket.onmessage = (event) => {
      const message = JSON.parse(String(event.data));
      const item = pending.get(message.id);
      if (!item) return;
      pending.delete(message.id);
      clearTimeout(item.timer);
      if (message.error) item.reject(new Error(JSON.stringify(message.error)));
      else item.resolve(message.result);
    };
    const send = (method: string, params: object = {}, sessionId?: string): Promise<any> => {
      const id = ++nextId;
      return new Promise((resolve, reject) => {
        const timer = setTimeout(() => {
          pending.delete(id);
          reject(new Error(`Browser command timed out: ${method}`));
        }, 10_000);
        pending.set(id, { resolve, reject, timer });
        socket!.send(JSON.stringify({ id, method, params, ...(sessionId ? { sessionId } : {}) }));
      });
    };
    const { targetId } = await send("Target.createTarget", { url: "about:blank" });
    const { sessionId } = await send("Target.attachToTarget", { targetId, flatten: true });
    await send(
      "Emulation.setDeviceMetricsOverride",
      { width: 1440, height: 1000, deviceScaleFactor: 1, mobile: false },
      sessionId,
    );
    await send("Page.navigate", { url }, sessionId);
    return {
      async dropFiles(paths: string[]) {
        const { root } = await send("DOM.getDocument", {}, sessionId);
        const { nodeId } = await send(
          "DOM.querySelector",
          { nodeId: root.nodeId, selector: '[data-testid="device-frame-viewport"]' },
          sessionId,
        );
        const { model } = await send("DOM.getBoxModel", { nodeId }, sessionId);
        const x = (model.content[0] + model.content[4]) / 2;
        const y = (model.content[1] + model.content[5]) / 2;
        for (const type of ["dragEnter", "dragOver", "drop"])
          await send(
            "Input.dispatchDragEvent",
            { type, x, y, data: { items: [], files: paths, dragOperationsMask: 1 } },
            sessionId,
          );
      },
      async waitForText(text: string) {
        const deadline = Date.now() + 60000;
        while (Date.now() < deadline) {
          const { root } = await send("DOM.getDocument", {}, sessionId);
          const { outerHTML } = await send("DOM.getOuterHTML", { nodeId: root.nodeId }, sessionId);
          if (outerHTML.includes(text)) return;
          await pause(100);
        }
        throw new Error(`Dashboard did not show ${text}`);
      },
      async screenshot() {
        return (await send("Page.captureScreenshot", { format: "png" }, sessionId)).data as string;
      },
      async close() {
        for (const item of pending.values()) {
          clearTimeout(item.timer);
          item.reject(new Error("Browser closed"));
        }
        pending.clear();
        socket?.close();
        await stopBrowser();
      },
    };
  } catch (error) {
    socket?.close();
    await stopBrowser();
    throw error;
  }
}
