#!/usr/bin/env bun
/**
 * Bundle the Expo Hub DevTools plugin server.
 *
 * expo-hub is an Expo DevTools plugin (see `expo-module.config.json`): Expo CLI
 * loads `dist/server/index.mjs` and calls its default-exported fetch handler for
 * requests to `/_expo/plugins/expo-hub/*`. The handler is authored in TypeScript
 * under `src/server/` and bundled here with Bun into a single, self-contained ESM
 * file — so `@expo-hub/apple-utils` and the device-listing logic ship inlined and
 * only Node built-ins stay external.
 *
 * Output (`dist/`) is gitignored; run `bun run build:server` before using the
 * plugin from a host app.
 */

import { rmSync } from 'node:fs';
import { resolve } from 'node:path';

const root = resolve(import.meta.dir, '..');
const outdir = resolve(root, 'dist/server');

rmSync(outdir, { recursive: true, force: true });

const result = await Bun.build({
  entrypoints: [resolve(root, 'src/server/index.ts')],
  outdir,
  target: 'node',
  format: 'esm',
  naming: '[dir]/[name].mjs',
  sourcemap: 'linked',
});

if (!result.success) {
  console.error('Failed to bundle the expo-hub DevTools server:');
  for (const message of result.logs) console.error(message);
  process.exit(1);
}

console.log('Bundled expo-hub DevTools server → dist/server/index.mjs');
