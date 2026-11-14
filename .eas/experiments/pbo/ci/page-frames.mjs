// page-frames.mjs <cdp port> <node_modules dir>: reads the frame counter of the page that paints
// each frame in the next color (fixtures/frame-counter.html), through Chrome's DevTools socket
// (adb forward tcp:<port> localabstract:chrome_devtools_remote). Prints {"frame": n, "pageMs": t,
// "hostMs": t} or {"error": ...}. The counter is the number of requestAnimationFrame callbacks.
import { createRequire } from "node:module";
import { join } from "node:path";

const [port, modules] = process.argv.slice(2);
const WebSocket = createRequire(join(modules, "noop.js"))("ws");
try {
  const pages = await (await fetch(`http://127.0.0.1:${port}/json`)).json();
  const page = pages.find((p) => p.type === "page" && p.url.includes("frame-counter"));
  if (!page) throw new Error(`no frame-counter page in ${pages.length} targets`);
  const socket = new WebSocket(page.webSocketDebuggerUrl);
  const result = await new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error("timeout")), 5000);
    socket.on("open", () =>
      socket.send(
        JSON.stringify({
          id: 1,
          method: "Runtime.evaluate",
          params: { expression: "JSON.stringify([frame, performance.now()])", returnByValue: true },
        }),
      ),
    );
    socket.on("message", (data) => {
      const message = JSON.parse(data.toString());
      if (message.id !== 1) return;
      clearTimeout(timer);
      resolve(message.result?.result?.value);
    });
    socket.on("error", reject);
  });
  socket.close();
  const [frame, pageMs] = JSON.parse(result);
  console.log(JSON.stringify({ frame, pageMs, hostMs: Date.now() }));
} catch (error) {
  console.log(JSON.stringify({ error: String(error?.message ?? error) }));
}
process.exit(0);
