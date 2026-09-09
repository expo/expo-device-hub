#!/usr/bin/env node
// swc (with jsc.rewriteRelativeImportExtensions) already rewrites the runtime
// `.js` specifiers from `./x.ts` to `./x.js`. tsc's own rewriteRelativeImportExtensions,
// however, rewrites emitted JS but NOT declaration files, so the generated
// `.d.ts` keep the source `./x.ts` specifiers. This pass rewrites any remaining
// relative `.ts` specifier in `dist` to `.js` so the shipped declarations resolve
// against the emitted `.js` files. Runs after swc + tsc.
import { readdirSync, statSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const distDir = join(dirname(fileURLToPath(import.meta.url)), "..", "dist");

function collect(dir) {
  const files = [];
  for (const entry of readdirSync(dir)) {
    if (entry === "ui") continue; // vite app bundle, not part of the library graph
    const p = join(dir, entry);
    if (statSync(p).isDirectory()) files.push(...collect(p));
    else if (entry.endsWith(".d.ts") || entry.endsWith(".js")) files.push(p);
  }
  return files;
}

// A quoted RELATIVE specifier ending in `.ts` — matches static import/export and
// dynamic import(). `.tsx` is not matched (the char before the quote would be `x`).
const RELATIVE_TS = /(["'])(\.\.?\/[^"']*?)\.ts\1/g;

let changed = 0;
for (const file of collect(distDir)) {
  const before = readFileSync(file, "utf8");
  const after = before.replace(RELATIVE_TS, (_m, quote, spec) => `${quote}${spec}.js${quote}`);
  if (after !== before) {
    writeFileSync(file, after);
    changed++;
  }
}
console.log(`fix-dist-imports: rewrote .ts → .js specifiers in ${changed} file(s)`);
