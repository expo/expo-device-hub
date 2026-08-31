import { describe, expect, test } from 'bun:test';
import type { IncomingMessage } from 'node:http';

import { requestOrigin } from '../cli/node-fetch-server';

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
