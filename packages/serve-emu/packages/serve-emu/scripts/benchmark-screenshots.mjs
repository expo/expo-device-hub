/** Run against a local serve-emu session; credentials stay in SERVE_EMU_TOKEN. */
import http from "node:http";
import https from "node:https";

const base = new URL(process.argv[2] ?? "http://127.0.0.1:3300");
if (!["http:", "https:"].includes(base.protocol)) throw new Error("Expected an HTTP endpoint");
const transport = base.protocol === "https:" ? https : http;
const agent =
  base.protocol === "https:"
    ? new https.Agent({ keepAlive: true, maxSockets: 1 })
    : new http.Agent({ keepAlive: true, maxSockets: 1 });
const variants = [
  { name: "native-png", query: "" },
  { name: "402-png", query: "maxWidth=402" },
  { name: "402-jpeg80", query: "maxWidth=402&format=jpeg&quality=80" },
];
const samples = [];
try {
  // Retain warmup separately; counterbalance modes on every other round.
  for (let round = 0; round < 8; round++) {
    for (const variant of round % 2 ? [...variants].reverse() : variants) {
      const url = new URL(`${base.pathname.replace(/\/$/, "")}/api/screenshot`, base);
      url.search = variant.query;
      const sample = await new Promise((resolve, reject) => {
        const started = performance.now();
        const token = process.env.SERVE_EMU_TOKEN;
        const request = transport.request(
          url,
          {
            method: "POST",
            agent,
            headers: token ? { Authorization: `Bearer ${token}` } : {},
            signal: AbortSignal.timeout(30_000),
          },
          (response) => {
            let bytes = 0;
            let prefix = Buffer.alloc(0);
            response.on("data", (chunk) => {
              bytes += chunk.length;
              if (prefix.length < 8)
                prefix = Buffer.concat([prefix, chunk.subarray(0, 8 - prefix.length)]);
              if (bytes > 64 * 1024 * 1024) response.destroy(new Error("Screenshot too large"));
            });
            response.on("error", reject);
            response.on("end", () => {
              if (response.statusCode !== 200)
                return reject(new Error("Screenshot request failed"));
              const jpeg = variant.name === "402-jpeg80";
              if (
                response.headers["content-type"] !== (jpeg ? "image/jpeg" : "image/png") ||
                !(jpeg
                  ? prefix.subarray(0, 3).equals(Buffer.from([255, 216, 255]))
                  : prefix.equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]))) ||
                Number(response.headers["content-length"]) !== bytes
              )
                return reject(new Error("Invalid screenshot response"));
              resolve({
                mode: variant.name,
                ms: performance.now() - started,
                bytes,
                reusedSocket: request.reusedSocket,
                stages: Object.fromEntries(
                  [
                    ...String(response.headers["server-timing"] ?? "").matchAll(
                      /([a-z]+);dur=([\d.]+)/g,
                    ),
                  ].map((m) => [m[1], Number(m[2])]),
                ),
              });
            });
          },
        );
        request.on("error", reject);
        request.end();
      });
      if (round > 0) samples.push(sample);
    }
  }
  const percentile = (values, p) =>
    [...values].sort((a, b) => a - b)[Math.ceil(values.length * p) - 1];
  console.log(
    JSON.stringify(
      {
        kind: "HTTP screenshot receipt",
        warmupSamplesExcluded: 3,
        groups: variants.map(({ name }) => {
          const rows = samples.filter((x) => x.mode === name);
          return {
            mode: name,
            n: rows.length,
            medianMs: percentile(
              rows.map((x) => x.ms),
              0.5,
            ),
            p95Ms: percentile(
              rows.map((x) => x.ms),
              0.95,
            ),
            bytes: percentile(
              rows.map((x) => x.bytes),
              0.5,
            ),
            reusedSockets: rows.filter((x) => x.reusedSocket).length,
          };
        }),
        samples,
      },
      null,
      2,
    ),
  );
} catch {
  console.error(
    "Screenshot benchmark failed; verify the local server, authentication, and device.",
  );
  process.exitCode = 1;
} finally {
  agent.destroy();
}
