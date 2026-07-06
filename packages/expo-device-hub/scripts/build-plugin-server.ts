#!/usr/bin/env bun
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
  plugins: [
    {
      name: 'externalize-vendor',
      setup(build) {
        // Must stay external: inlining rebases serve-sim/serve-emu's `import.meta.url`-relative
        // native-binary lookups onto `dist/server/` and breaks them at runtime.
        build.onResolve(
          { filter: /\/vendor\/serve-(sim|emu)\/dist\/middleware\.js$/ },
          (args) => ({ path: args.path, external: true }),
        );
      },
    },
  ],
});

if (!result.success) {
  console.error('Failed to bundle the expo-device-hub DevTools server:');
  for (const message of result.logs) console.error(message);
  process.exit(1);
}

console.log('Bundled expo-device-hub DevTools server → dist/server/index.mjs');
