#!/usr/bin/env bun
import { execFileSync } from 'node:child_process';
import { mkdirSync, readdirSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { resolve, sep } from 'node:path';

const root = resolve(import.meta.dir, '..');
const vendorDir = resolve(root, 'vendor');
const require = createRequire(import.meta.url);

const { dependencies = {} } = require(resolve(root, 'package.json')) as {
  dependencies?: Record<string, string>;
};
const deps = Object.keys(dependencies);

rmSync(vendorDir, { recursive: true, force: true });
mkdirSync(vendorDir, { recursive: true });

for (const name of deps) {
  const packageDir = realpathSync(resolve(root, 'node_modules', name));
  const dest = resolve(vendorDir, name);
  mkdirSync(dest, { recursive: true });

  execFileSync('npm', ['pack', '--ignore-scripts', '--pack-destination', dest], {
    cwd: packageDir,
    stdio: 'ignore',
  });

  const tarball = readdirSync(dest).find((file) => file.endsWith('.tgz'));
  if (!tarball) throw new Error(`npm pack produced no tarball for "${name}"`);

  execFileSync('tar', ['-xzf', resolve(dest, tarball), '-C', dest, '--strip-components=1'], {
    stdio: 'ignore',
  });
  rmSync(resolve(dest, tarball), { force: true });

  const manifests = readdirSync(dest, { recursive: true })
    .map(String)
    .filter((file) => file.split(sep).pop() === 'package.json');
  for (const manifest of manifests) rmSync(resolve(dest, manifest), { force: true });

  console.log(`Vendored ${name} → vendor/${name}`);
}
