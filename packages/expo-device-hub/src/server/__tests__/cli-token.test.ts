import { afterAll, beforeAll, expect, test } from 'bun:test';
import { mkdtemp, readFile, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';

let directory: string;

beforeAll(async () => {
  directory = await mkdtemp(join(tmpdir(), 'hub-cli-test-'));
  // Exercise the real CLI and Hub router without starting native middleware.
  const result = await Bun.build({
    entrypoints: [resolve(import.meta.dir, '../cli.ts'), resolve(import.meta.dir, '../index.ts')],
    outdir: directory,
    target: 'bun',
    naming: '[name].mjs',
    plugins: [{
      name: 'native-middleware-stubs',
      setup(build) {
        build.onResolve({ filter: /^\.\/index\.mjs$/ }, () => ({ path: './index.mjs', external: true }));
        build.onLoad({ filter: /\/server\/serve-sim\.ts$/ }, () => ({
          loader: 'js',
          contents: `export const SIM_PREFIX = '/vendor/serve-sim';
            export const handleSimRequest = () => new Response('sim');
            export const simWebSocketHandler = () => {};`,
        }));
        build.onLoad({ filter: /\/server\/serve-emu\.ts$/ }, () => ({
          loader: 'js',
          contents: `export const EMU_PREFIX = '/vendor/serve-emu';
            export const emuCameraFeeds = {};
            export const handleEmuRequest = () => new Response('emu');
            export const emuWebSocketHandler = () => {};
            export const finishAndroidScreenRecording = async () => ({});
            export const startAndroidScreenRecording = async () => ({});
            export const shutdownAndroid = async () => {};`,
        }));
      },
    }],
  });
  if (!result.success) throw new Error(result.logs.join('\n'));
});

afterAll(async () => {
  if (directory) await rm(directory, { recursive: true, force: true });
});

async function startHub(requireToken: boolean) {
  const process = Bun.spawn([
    Bun.which('bun')!, join(directory, 'cli.mjs'), '--port', '0',
    ...(requireToken ? ['--require-token'] : []),
  ], { stdout: 'pipe', stderr: 'pipe' });
  let output = '';
  let errors = '';
  const readErrors = new Response(process.stderr).text().then((value) => { errors = value; });
  const reader = process.stdout.getReader();
  const readOutput = (async () => {
    for (;;) {
      const next = await reader.read();
      if (next.done) return;
      output += new TextDecoder().decode(next.value);
    }
  })();
  const stop = async () => {
    process.kill('SIGTERM');
    await process.exited;
    await readOutput;
    await readErrors;
  };
  try {
    for (let attempt = 0; attempt < 200; attempt++) {
      if (output.includes('Network:')) {
        // Startup writes the session file after binding the port.
        await Bun.sleep(50);
        const origin = output.match(/Local:\s+(http:\/\/[^\s/]+)/)?.[1];
        if (origin) return { origin, output: () => output + errors, stop };
      }
      await Bun.sleep(10);
    }
    throw new Error('CLI did not report a listening address');
  } catch (error) {
    await stop();
    throw error;
  }
}

test('require-token refuses unauthenticated lifecycle requests before parsing the body', async () => {
  const hub = await startHub(true);
  try {
    for (const action of ['boot', 'create', 'shutdown', 'remove']) {
      for (const headers of [{}, { authorization: 'Bearer wrong' }]) {
        const response = await fetch(`${hub.origin}/api/devices/${action}`, {
          method: 'POST', headers, body: '{}',
        });
        expect(response.status).toBe(401);
      }
    }
  } finally {
    await hub.stop();
  }
});

test('keeps credentials out of CLI output and allows authenticated lifecycle requests', async () => {
  const hub = await startHub(true);
  let linkFile: string | undefined;
  let token: string | null = null;
  try {
    linkFile = hub.output().match(/Session links:\s+([^\n]+)/)?.[1]?.trim();
    expect(linkFile).toBeDefined();
    const link = new URL((await readFile(linkFile!, 'utf8')).trim().split('\n')[0]!);
    token = new URLSearchParams(link.hash.slice(1)).get('token');
    expect(Boolean(token)).toBe(true);
    expect(hub.output().includes(token!)).toBe(false);
    expect(hub.output()).not.toContain('?token=');
    expect(hub.output()).not.toContain('#token=');
    expect((await stat(linkFile!)).mode & 0o777).toBe(0o600);
    expect((await stat(dirname(linkFile!))).mode & 0o777).toBe(0o700);
    for (const action of ['boot', 'create', 'shutdown', 'remove']) {
      const response = await fetch(`${hub.origin}/api/devices/${action}`, {
        method: 'POST', headers: { authorization: `Bearer ${token}` }, body: '{}',
      });
      // Invalid bodies prevent any real simulator or emulator mutation.
      expect(response.status).toBe(400);
    }
  } finally {
    await hub.stop();
  }
  expect(hub.output().includes(token!)).toBe(false);
  if (linkFile) expect(await Bun.file(linkFile).exists()).toBe(false);
});

test('keeps lifecycle requests available without require-token', async () => {
  const hub = await startHub(false);
  try {
    for (const action of ['boot', 'create', 'shutdown', 'remove']) {
      const response = await fetch(`${hub.origin}/api/devices/${action}`, {
        method: 'POST', body: '{}',
      });
      expect(response.status).toBe(400);
    }
    expect(hub.output()).not.toContain('Session links:');
  } finally {
    await hub.stop();
  }
});
