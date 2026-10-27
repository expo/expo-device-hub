import assert from "node:assert/strict";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";

const { simMiddleware } = await import(pathToFileURL(resolve(process.argv[2])).href);
const middleware = simMiddleware({
  basePath: "/_expo/plugins/expo-device-hub/vendor/serve-sim",
  proxyHelpers: true,
});
assert.equal(typeof middleware, "function");
assert.equal(typeof middleware.handleUpgrade, "function");
assert.equal(typeof middleware.handleWebSocket, "function");
console.log("serve-sim middleware initializes on Node");
