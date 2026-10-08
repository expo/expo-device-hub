import { unlinkSync } from "fs";
import { simMiddleware } from "../../middleware";

const middleware = simMiddleware({ loopbackOnly: true });
if (process.argv[2] === "before boot") unlinkSync(process.env.SERVE_SIM_ADDITIONAL_DYLIBS!);

const response = await middleware(new Request("http://127.0.0.1:3200/.sim/grid/api/start", {
  method: "POST",
  body: JSON.stringify({ udid: "11111111-2222-3333-4444-555555555555" }),
}));
console.log(JSON.stringify({ status: response?.status, body: await response?.json() }));

const health = await middleware(new Request("http://127.0.0.1:3200/.sim/healthz"));
console.log(JSON.stringify({ health: health?.status }));
process.exit(0);
