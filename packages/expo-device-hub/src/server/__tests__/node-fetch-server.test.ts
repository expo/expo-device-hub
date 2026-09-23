import { describe, expect, test } from 'bun:test';
import type { IncomingMessage } from 'node:http';
import { PassThrough } from 'node:stream';

import { incomingBodyStream, requestOrigin, toFetchRequest } from '../cli/node-fetch-server';

describe(incomingBodyStream, () => {
  test('delivers the whole body to a consumer that reads it', async () => {
    const source = new PassThrough();
    const stream = incomingBodyStream(source);
    source.write('{"udid":');
    source.end('"x"}');
    expect(await new Response(stream).text()).toBe('{"udid":"x"}');
  });

  test('survives body data arriving after the consumer cancelled', async () => {
    // A handler that answered 401 before reading the body: the Request's stream
    // is cancelled, then the socket keeps delivering the body. This used to throw
    // "Controller is already closed" from the data listener and kill the process.
    const source = new PassThrough();
    const stream = incomingBodyStream(source);
    await stream.cancel();
    source.write('late body');
    source.end();
    await new Promise((resolve) => source.once('end', resolve));
    expect(source.readableEnded).toBe(true);
  });

  test('toFetchRequest carries the body for a POST and none for a GET', async () => {
    const socket = new PassThrough();
    const post = Object.assign(socket, {
      method: 'POST',
      url: '/grid/api/start',
      headers: { host: 'hub.test' },
      rawHeaders: ['host', 'hub.test', 'content-type', 'application/json'],
      socket: {},
    }) as unknown as IncomingMessage;
    const request = toFetchRequest(post);
    socket.end('{"udid":"x"}');
    expect(request.method).toBe('POST');
    expect(request.url).toBe('http://hub.test/grid/api/start');
    expect(request.headers.get('content-type')).toBe('application/json');
    expect(await request.json()).toEqual({ udid: 'x' });

    const get = { method: 'GET', url: '/', headers: { host: 'hub.test' }, rawHeaders: [], socket: {} };
    expect(toFetchRequest(get as unknown as IncomingMessage).body).toBeNull();
  });
});

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
