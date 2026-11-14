// page-info.mjs <cdp port> <node_modules dir>: what Chrome on the guest reports about the device,
// read from the frame-counter page through Chrome's DevTools socket: navigator.deviceMemory
// (Chrome rounds it, and lowers it on a low-RAM device), hardwareConcurrency, the viewport and
// the user agent. Prints one JSON line.
import { createRequire } from "node:module";
import { join } from "node:path";

const [port, modules] = process.argv.slice(2);
const WebSocket = createRequire(join(modules, "noop.js"))("ws");
const expression = `JSON.stringify({deviceMemory: navigator.deviceMemory, hardwareConcurrency: navigator.hardwareConcurrency,
  devicePixelRatio, innerWidth, innerHeight, userAgent: navigator.userAgent})`;
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
          params: { expression, returnByValue: true },
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
  console.log(result);
} catch (error) {
  console.log(JSON.stringify({ error: String(error?.message ?? error) }));
}
process.exit(0);
