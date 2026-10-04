import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";

const repo = resolve(process.argv[2] ?? ".");
const output = resolve(process.argv[3] ?? "hid-close-results");
const prefix = "packages/serve-sim/packages/serve-sim/src/";
const baseline = "128085cc165cee6ad0868e9cd8661d8e2427c1f4";
const final = "3c801d389caa6d403ac54bf39d670a44aec24288";
const variants = ["baseline", "end-only", "grace", "final"];
const dependencies = ["socket/server-input.ts", "socket/server-upgrade.ts", "socket/heartbeat.ts", "socket/frames.ts", "session-auth.ts", "unauthorized-page.ts"];
const sha256 = (value: string) => createHash("sha256").update(value).digest("hex");
const metadata: Record<string, unknown> = {};

mkdirSync(output, { recursive: true, mode: 0o700 });
for (const variant of variants) {
  const revision = variant === "final" ? final : baseline;
  const hashes: Record<string, string> = {};
  for (const dependency of dependencies) {
    let source = execFileSync("git", ["-C", repo, "show", `${revision}:${prefix}${dependency}`], { encoding: "utf8" });
    if (dependency === "socket/server-input.ts" && ["end-only", "grace"].includes(variant)) {
      source = readFileSync(join(import.meta.dir, `${variant}-input.ts`), "utf8");
    }
    hashes[dependency] = sha256(source);
    const file = join(output, "sources", variant, dependency);
    mkdirSync(dirname(file), { recursive: true });
    writeFileSync(file, source);
  }
  const entry = join(output, `${variant}-entry.ts`);
  writeFileSync(entry, `export { rawHidSocket } from "./sources/${variant}/socket/server-input";\nexport { writeWebSocketAccept } from "./sources/${variant}/socket/server-upgrade";\n`);
  const build = await Bun.build({ entrypoints: [entry], outdir: output, naming: `${variant}-adapter.cjs`, target: "node", format: "cjs" });
  if (!build.success) throw new Error(build.logs.map(String).join("\n"));
  metadata[variant] = { revision, hashes, note: variant === "final" ? "Exact published source" : variant === "baseline" ? "Exact original source; identical adapter source in PR243" : "Archived diagnostic prototype with local imports made relative" };
}
writeFileSync(join(output, "source-variants.json"), JSON.stringify(metadata, null, 2) + "\n");
console.log(`Built ${variants.length} Node adapters in ${output}`);
