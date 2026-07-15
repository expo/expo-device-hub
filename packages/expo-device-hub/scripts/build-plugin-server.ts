#!/usr/bin/env bun
import { promises } from 'node:fs';
import { resolve } from 'node:path';

const { rm, chmod } = promises;

const root = resolve(import.meta.dir, '..');
const outdir = resolve(root, 'dist/server');

await rm(outdir, { recursive: true, force: true });

const serverResult = await Bun.build({
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

if (!serverResult.success) {
  console.error('Failed to bundle the expo-device-hub DevTools server:');
  for (const message of serverResult.logs) console.error(message);
  process.exit(1);
}

console.log('Bundled expo-device-hub DevTools server → dist/server/index.mjs');

const cliResult = await Bun.build({
  entrypoints: [resolve(root, 'src/server/cli.ts')],
  outdir,
  target: 'node',
  format: 'esm',
  naming: '[dir]/[name].mjs',
  sourcemap: 'linked',
  banner: '#!/usr/bin/env node',
  external: ['ws'],
  plugins: [
    {
      name: 'externalize-plugin-server',
      setup(build) {
        // Externalize src/server/index.ts
        build.onResolve({ filter: /^\.\/index\.mjs$/ }, (args) => ({
          path: args.path,
          external: true,
        }));
      },
    },
  ],
});

if (!cliResult.success) {
  console.error('Failed to bundle the expo-device-hub CLI:');
  for (const message of cliResult.logs) console.error(message);
  process.exit(1);
}

await chmod(resolve(outdir, 'cli.mjs'), 0o755);
console.log('Bundled expo-device-hub CLI → dist/server/cli.mjs');
