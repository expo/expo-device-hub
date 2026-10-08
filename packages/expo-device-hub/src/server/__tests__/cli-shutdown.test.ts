import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { spawn } from 'node:child_process';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

// The CLI imports its server bundle as the sibling `./index.mjs`. This stub stands in for it, so the
// tests run the real signal handler without simulators or emulators. serve-sim's release takes
// 300 ms, as a clipboard setup that is still running would, or fails when the environment says so.
const STUB_SERVER = `
export default async () => null;
export const staticFileHeaders = {};
export const webSocketHandlers = {};
export const startAndroidScreenRecording = async () => ({ started: false, reason: 'stub' });
export const shutdownAndroid = async () => {
  if (process.env.STUB_ANDROID === 'reject') throw new Error('Android failed on purpose');
  console.log('Android stopped');
};
export const shutdownServeSim = async () => {
  await new Promise((resolve) => setTimeout(resolve, 300));
  if (process.env.STUB_SERVE_SIM === 'reject') throw new Error('serve-sim failed on purpose');
  console.log('serve-sim stopped');
};
`;

let directory: string;

beforeAll(async () => {
  directory = await mkdtemp(join(tmpdir(), 'hub-cli-shutdown-'));
  const build = await Bun.build({
    entrypoints: [join(import.meta.dir, '../cli.ts')],
    outdir: directory,
    naming: '[name].mjs',
    target: 'node',
    format: 'esm',
    plugins: [
      {
        name: 'externalize-plugin-server',
        setup(build) {
          build.onResolve({ filter: /^\.\/index\.mjs$/ }, (args) => ({ path: args.path, external: true }));
        },
      },
    ],
  });
  expect(build.success, build.logs.join('\n')).toBe(true);
  await writeFile(join(directory, 'index.mjs'), STUB_SERVER);
});

afterAll(async () => {
  await rm(directory, { recursive: true, force: true });
});

/** Starts the built CLI under Node, sends SIGINT once it is ready, and waits for it to exit. */
function interruptWhenReady(env: Record<string, string>): Promise<{ code: number | null; stdout: string; stderr: string }> {
  const child = spawn('node', [join(directory, 'cli.mjs'), '--port', '0'], {
    env: { ...process.env, ...env },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let stdout = '';
  let stderr = '';
  let signalled = false;
  child.stderr.setEncoding('utf8').on('data', (chunk: string) => (stderr += chunk));
  child.stdout.setEncoding('utf8').on('data', (chunk: string) => {
    stdout += chunk;
    if (!signalled && stdout.includes('Expo Device Hub ready')) {
      signalled = true;
      child.kill('SIGINT');
    }
  });
  const timeout = setTimeout(() => child.kill('SIGKILL'), 10_000);
  return new Promise((resolve, reject) => {
    child.once('error', reject);
    child.once('close', (code) => {
      clearTimeout(timeout);
      if (!signalled) reject(new Error(`The CLI exited before it was ready:\n${stdout}${stderr}`));
      else resolve({ code, stdout, stderr });
    });
  });
}

describe('Hub CLI shutdown', () => {
  test("waits for serve-sim's clipboard release, then exits 0", async () => {
    const result = await interruptWhenReady({});

    expect(result.code, result.stderr).toBe(0);
    expect(result.stdout).toContain('Android stopped');
    expect(result.stdout).toContain('serve-sim stopped');
  }, 15_000);

  test("logs a failed serve-sim release and still exits 0", async () => {
    const result = await interruptWhenReady({ STUB_SERVE_SIM: 'reject' });

    expect(result.code, result.stderr).toBe(0);
    expect(result.stderr).toContain('serve-sim shutdown failed: Error: serve-sim failed on purpose');
    expect(result.stdout).toContain('Android stopped');
  }, 15_000);

  test('still releases serve-sim when Android recording fails to stop', async () => {
    const result = await interruptWhenReady({ STUB_ANDROID: 'reject' });

    expect(result.code).toBe(1);
    expect(result.stderr).toContain('Android recording shutdown failed: Error: Android failed on purpose');
    expect(result.stdout).toContain('serve-sim stopped');
  }, 15_000);
});
