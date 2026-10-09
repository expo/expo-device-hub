#!/usr/bin/env bun
// Compares src/sim-slim/catalog.ts with simslim's profiles.go at a tag; exits 1 on a difference.
// Run by hand (it needs the network): bun scripts/sim-slim-sync.ts [--tag v0.11.0] [--file profiles.go]
import { readFileSync } from "fs";
import { NEVER_SLIM, SLIM_CATEGORIES } from "../src/sim-slim/catalog";

const args = process.argv.slice(2);
const option = (name: string) => {
  const index = args.indexOf(name);
  return index === -1 ? undefined : args[index + 1];
};
const tag = option("--tag") ?? "v0.11.0";
const file = option("--file");

async function upstreamSource(): Promise<string> {
  if (file) return readFileSync(file, "utf8");
  const url = `https://raw.githubusercontent.com/MobAI-App/simslim/${tag}/profiles.go`;
  const res = await fetch(url, { signal: AbortSignal.timeout(30_000) });
  if (!res.ok) throw new Error(`${url}: HTTP ${res.status}`);
  return res.text();
}

/** Category id to labels, and the always-enabled labels, from `var Categories` in profiles.go. */
function parseProfiles(source: string): { categories: Map<string, string[]>; alwaysEnabled: string[] } {
  const start = source.indexOf("var Categories = []Category{");
  if (start === -1) throw new Error("profiles.go: `var Categories` not found; the upstream layout changed");
  const body = source.slice(start, source.indexOf("\n}\n", start));
  const categories = new Map<string, string[]>();
  for (const block of body.split(/\n\t\{\n/).slice(1)) {
    const id = /\bID:\s*"([^"]+)"/.exec(block)?.[1];
    const labels = /\bLabels:\s*\[\]string\{([^}]*)\}/.exec(block)?.[1];
    if (!id || labels === undefined) throw new Error(`profiles.go: a category without ID or Labels:\n${block.slice(0, 200)}`);
    categories.set(id, [...labels.matchAll(/"([^"]+)"/g)].map((m) => m[1]!));
  }
  const alwaysEnabled = [...body.matchAll(/\bLabel:\s*"([^"]+)"/g)].map((m) => m[1]!);
  return { categories, alwaysEnabled };
}

const upstream = parseProfiles(await upstreamSource());
const theirs = new Map<string, string[]>();
for (const [id, labels] of upstream.categories) {
  for (const label of labels) theirs.set(label, [...(theirs.get(label) ?? []), id]);
}
const ours = new Map(SLIM_CATEGORIES.flatMap((c) => c.labels.map((label) => [label, c.id] as const)));

const onlyTheirs = [...theirs.keys()].filter((l) => !ours.has(l)).sort();
const onlyOurs = [...ours.keys()].filter((l) => !theirs.has(l)).sort();
const keptOnUpstream = upstream.alwaysEnabled.filter((l) => ours.has(l));
const notInNeverSlim = upstream.alwaysEnabled.filter((l) => !(l in NEVER_SLIM));

console.log(`simslim ${file ?? tag}: ${upstream.categories.size} categories, ${theirs.size} labels. ` +
  `serve-sim: ${SLIM_CATEGORIES.length} categories, ${ours.size} labels.`);
const section = (title: string, lines: string[]) => {
  if (lines.length) console.log(`\n${title} (${lines.length}):\n${lines.map((l) => `  ${l}`).join("\n")}`);
};
section("Only upstream: check each on the new runtime before adding it to a category",
  onlyTheirs.map((l) => `${l}  [${theirs.get(l)!.join(", ")}]`));
section("Only serve-sim: upstream dropped or never had these", onlyOurs.map((l) => `${l}  [${ours.get(l)}]`));
section("Upstream keeps these on, but a serve-sim category disables them", keptOnUpstream);
section("Upstream keeps these on; consider adding them to NEVER_SLIM", notInNeverSlim);

const differs = onlyTheirs.length > 0 || onlyOurs.length > 0 || keptOnUpstream.length > 0;
if (!differs) console.log("\nThe label sets match.");
process.exitCode = differs ? 1 : 0;
