#!/usr/bin/env bun
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, join, relative, resolve, sep } from 'node:path';
import { pathToFileURL } from 'node:url';

type PackReport = {
  filename?: string;
  files?: Array<{ path?: string }>;
};

const packageRoot = resolve(import.meta.dir, '..');
const sharedRuntimeRoot = join(packageRoot, 'vendor', 'serve-emu', 'dist', 'shared');

if (!existsSync(sharedRuntimeRoot)) {
  throw new Error('serve-emu shared runtime directory is missing; run build:vendor first');
}

const expectedFiles = readdirSync(sharedRuntimeRoot)
  .filter((file) => file.endsWith('.js'))
  .map((file) => relative(packageRoot, join(sharedRuntimeRoot, file)).split(sep).join('/'))
  .sort();

if (expectedFiles.length === 0) {
  throw new Error('serve-emu has no vendored dist/shared runtime files; run build:vendor first');
}

const output = execFileSync('npm', ['pack', '--dry-run', '--json', '--ignore-scripts'], {
  cwd: packageRoot,
  encoding: 'utf8',
});
const [report] = JSON.parse(output) as PackReport[];
const manifest = new Set(
  report?.files?.flatMap((file) => (typeof file.path === 'string' ? [file.path] : [])) ?? [],
);
const missingFiles = expectedFiles.filter((file) => !manifest.has(file));

if (missingFiles.length > 0) {
  throw new Error(`package archive is missing serve-emu shared runtime files:\n${missingFiles.join('\n')}`);
}

const temporaryRoot = mkdtempSync(join(tmpdir(), 'expo-device-hub-package-smoke-'));
try {
  const packedOutput = execFileSync(
    'npm',
    ['pack', '--json', '--ignore-scripts', '--pack-destination', temporaryRoot],
    {
      cwd: packageRoot,
      encoding: 'utf8',
    },
  );
  const [packedReport] = JSON.parse(packedOutput) as PackReport[];
  if (
    typeof packedReport?.filename !== 'string' ||
    basename(packedReport.filename) !== packedReport.filename
  ) {
    throw new Error('npm pack returned an invalid archive filename');
  }

  const extractedRoot = join(temporaryRoot, 'extracted');
  mkdirSync(extractedRoot);
  execFileSync(
    'tar',
    ['-xzf', join(temporaryRoot, packedReport.filename), '-C', extractedRoot],
    { stdio: 'inherit' },
  );

  const packedApiContracts = join(
    extractedRoot,
    'package',
    'vendor',
    'serve-emu',
    'dist',
    'shared',
    'api-contracts.js',
  );
  execFileSync(
    'node',
    [
      '--input-type=module',
      '--eval',
      `await import(${JSON.stringify(pathToFileURL(packedApiContracts).href)})`,
    ],
    { stdio: 'inherit' },
  );
} finally {
  rmSync(temporaryRoot, { recursive: true, force: true });
}

console.log(`Package smoke test passed (${expectedFiles.length} serve-emu shared runtime files)`);
