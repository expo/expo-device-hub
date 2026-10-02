import assert from 'node:assert/strict';
import { once } from 'node:events';
import { Agent, createServer, request, type IncomingMessage } from 'node:http';
import type { AddressInfo } from 'node:net';
import { after, test } from 'node:test';

import { toFetchRequest, writeFetchResponse } from '../../cli/node-fetch-server';

let cancelledBody: Promise<void> | undefined;
let abortedBody: Promise<unknown> | undefined;
const server = createServer((req, res) => {
  // Backend routing forwards the Fetch request before middleware can reject it.
  const forwarded = new Request(toFetchRequest(req));
  if (req.url === '/reject') {
    cancelledBody = forwarded.body!.cancel();
    writeFetchResponse(new Response('Unauthorized', { status: 401 }), res);
  } else if (req.url === '/echo') {
    writeFetchResponse(new Response(forwarded.body), res);
  } else if (req.url === '/abort') {
    abortedBody = forwarded.text().then(
      () => assert.fail('A truncated upload must reject the body read'),
      (error: unknown) => assert.ok(error instanceof Error),
    );
    res.writeHead(200);
    res.flushHeaders();
  } else {
    res.end('ready');
  }
});
server.listen(0, '127.0.0.1');
await once(server, 'listening');
const port = (server.address() as AddressInfo).port;
const agent = new Agent({ keepAlive: true, maxSockets: 1 });

after(() => {
  agent.destroy();
  server.closeAllConnections();
  server.close();
});

async function read(response: IncomingMessage): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const chunk of response) chunks.push(chunk);
  return Buffer.concat(chunks).toString();
}

test('cancelling a forwarded POST body returns 401 without crashing Node', { timeout: 2000 }, async () => {
  const response = await fetch(`http://127.0.0.1:${port}/reject`, { method: 'POST', body: '{}' });
  assert.equal(response.status, 401);
  assert.equal(await response.text(), 'Unauthorized');
  await cancelledBody;
});

test('an immediately rejected POST returns its response and keeps the connection usable', { timeout: 2000 }, async () => {
  const upload = request({ host: '127.0.0.1', port, path: '/reject', method: 'POST', agent });
  const responsePromise = once(upload, 'response');
  upload.end('{}');
  const [response] = await responsePromise as [IncomingMessage];
  const socket = response.socket;
  assert.equal(response.statusCode, 401);
  assert.equal(await read(response), 'Unauthorized');
  await cancelledBody;

  const next = request({ host: '127.0.0.1', port, path: '/ready', agent });
  const nextResponse = once(next, 'response');
  next.end();
  const [ready] = await nextResponse as [IncomingMessage];
  assert.equal(ready.socket, socket);
  assert.equal(await read(ready), 'ready');
});

test('a rejected upload can finish arriving after its response', { timeout: 2000 }, async () => {
  const upload = request({ host: '127.0.0.1', port, path: '/reject', method: 'POST', agent });
  const responsePromise = once(upload, 'response');
  upload.write('first chunk');
  const [response] = await responsePromise as [IncomingMessage];
  assert.equal(response.statusCode, 401);
  assert.equal(await read(response), 'Unauthorized');
  upload.end('last chunk');
  await cancelledBody;
});

test('accepted uploads and responses stream before the upload finishes', { timeout: 2000 }, async () => {
  const upload = request({ host: '127.0.0.1', port, path: '/echo', method: 'POST', agent });
  const responsePromise = once(upload, 'response');
  upload.write('first chunk');
  const [response] = await responsePromise as [IncomingMessage];
  const chunks: Buffer[] = [];
  response.on('data', (chunk: Buffer) => chunks.push(chunk));
  await once(response, 'data');
  assert.equal(Buffer.concat(chunks).toString(), 'first chunk');
  upload.end('last chunk');
  await once(response, 'end');
  assert.equal(Buffer.concat(chunks).toString(), 'first chunklast chunk');
});

test('a disconnected uploader rejects the pending body read', { timeout: 2000 }, async () => {
  const upload = request({ host: '127.0.0.1', port, path: '/abort', method: 'POST', agent });
  const responsePromise = once(upload, 'response');
  upload.write('partial');
  const [response] = await responsePromise as [IncomingMessage];
  response.on('error', () => {});
  upload.destroy();
  await abortedBody;
});
