import { describe, expect, test } from 'bun:test';
import { spawnSync } from 'node:child_process';
import { mkdtemp, rm } from 'node:fs/promises';
import type { IncomingMessage } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { requestOrigin } from '../cli/node-fetch-server';

test('the Node HTTP bridge handles cancelled and streaming request bodies', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'hub-node-fetch-'));
  try {
    const outfile = join(directory, 'node-fetch-server.mjs');
    const build = await Bun.build({
      entrypoints: [join(import.meta.dir, 'fixtures/node-fetch-server.ts')],
      outdir: directory,
      naming: 'node-fetch-server.mjs',
      target: 'node',
    });
    expect(build.success).toBe(true);
    // Exercise the real Node stream implementation, not Bun's compatibility layer.
    const result = spawnSync('node', ['--test', outfile], { encoding: 'utf8', timeout: 15_000 });
    expect(result.error).toBeUndefined();
    expect(result.status, result.stdout + result.stderr).toBe(0);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}, 20_000);

function incomingRequest({
  encrypted = false,
  forwardedProto,
  host = 'preview.example.test',
}: {
  encrypted?: boolean;
  forwardedProto?: string;
  host?: string;
} = {}): IncomingMessage {
  return {
    headers: {
      host,
      ...(forwardedProto ? { 'x-forwarded-proto': forwardedProto } : {}),
    },
    socket: encrypted ? { encrypted: true } : {},
  } as IncomingMessage;
}

describe(requestOrigin, () => {
  test('uses the forwarded protocol when TLS terminates at a reverse proxy', () => {
    expect(requestOrigin(incomingRequest({ forwardedProto: 'https' }))).toBe('https://preview.example.test');
  });

  test('uses the client-facing protocol from a proxy chain', () => {
    expect(requestOrigin(incomingRequest({ forwardedProto: 'https, http' }))).toBe(
      'https://preview.example.test'
    );
  });

  test('falls back to the socket protocol for unsupported forwarded values', () => {
    expect(requestOrigin(incomingRequest({ encrypted: true, forwardedProto: 'ftp' }))).toBe(
      'https://preview.example.test'
    );
  });
});
