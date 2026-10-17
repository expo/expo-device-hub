import { describe, expect, test } from 'bun:test';

import { hostAllowed, isAllowedHost } from '../host-check';

// Loaded through a variable, so the Hub's type check does not compile the device servers' sources.
const SIM_HOSTS = '../../../../serve-sim/packages/serve-sim/src/host-allowlist.ts';
const EMU_HOSTS = '../../../../serve-emu/packages/serve-emu/src/host-allowlist.ts';

const HOSTS = [
  'localhost',
  'localhost:3400',
  'preview.localhost:3400',
  'LOCALHOST.:3400',
  '127.0.0.1:3400',
  '192.168.1.20:3400',
  '[::1]:3400',
  '::1',
  'rebound.example',
  'rebound.example:3400',
  'localhost.rebound.example',
  '127.0.0.1.rebound.example',
  'localhost:notaport',
  'localhost, rebound.example',
];

describe('hostAllowed', () => {
  // A page on another name that resolves here (DNS rebinding) carries that name in Host.
  test('without a token, answers only localhost, *.localhost, and IP addresses', () => {
    expect(hostAllowed('rebound.example:3400', undefined, false)).toBe(false);
    expect(hostAllowed('localhost:3400', undefined, false)).toBe(true);
    expect(hostAllowed('192.168.1.20:3400', undefined, false)).toBe(true);
    // Only a client that is not a browser omits Host.
    expect(hostAllowed(null, undefined, false)).toBe(true);
  });

  test('leaves the host to the token, or to --allow-any-host-when-insecure', () => {
    expect(hostAllowed('rebound.example:3400', 'token', false)).toBe(true);
    expect(hostAllowed('rebound.example:3400', undefined, true)).toBe(true);
  });

  // The Hub, serve-sim, and serve-emu must answer the same hosts, so a page sees one rule.
  test('allows the same hosts as serve-sim and serve-emu', async () => {
    const sim = (await import(SIM_HOSTS)) as { isAllowedHost: (host: string) => boolean };
    const emu = (await import(EMU_HOSTS)) as { isAllowedHost: (host: string) => boolean };
    for (const host of HOSTS) {
      expect([host, isAllowedHost(host)]).toEqual([host, sim.isAllowedHost(host)]);
      expect([host, isAllowedHost(host)]).toEqual([host, emu.isAllowedHost(host)]);
    }
  });
});
