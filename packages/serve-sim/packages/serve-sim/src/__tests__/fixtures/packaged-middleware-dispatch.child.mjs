import assert from "node:assert/strict";
import http from "node:http";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { WebSocket, WebSocketServer } from "ws";

const { simMiddleware } = await import(pathToFileURL(resolve(process.argv[2])).href);
const token = "bundle-dispatch-test";
const udid = "00000000-0000-0000-0000-000000000001";
const middleware = simMiddleware({ basePath: "/", execToken: token, device: udid });
const server = http.createServer();
const sockets = new WebSocketServer({ noServer: true });
server.on("upgrade", (req, socket, head) => {
  const request = new Request("http://127.0.0.1" + req.url, { headers: req.headers });
  sockets.handleUpgrade(req, socket, head, (ws) => middleware.handleWebSocket(request, ws));
});
await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
try {
  const reply = await new Promise((resolve, reject) => {
    const ws = new WebSocket("ws://127.0.0.1:" + server.address().port + "/exec-ws", [
      "serve-sim.token." + token,
    ]);
    ws.on("error", reject);
    ws.on("message", (raw) => {
      const value = JSON.parse(String(raw));
      if (value.ready)
        ws.send(JSON.stringify({ id: 1, action: "permissions.list", params: { udid } }));
      if (value.id === 1) {
        ws.close();
        resolve(value);
      }
    });
  });
  assert.equal(reply.error, undefined);
  assert.equal(reply.exitCode, 0, reply.stderr);
  assert.equal(reply.stderr, "");
  assert.equal(JSON.parse(reply.stdout).udid, udid);
} finally {
  for (const socket of sockets.clients) socket.terminate();
  sockets.close();
  server.close();
  await middleware.dispose();
}
