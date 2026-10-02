import { afterEach, expect, test } from 'bun:test';
import { createControlSocket } from '../control-socket.js';
class Socket {
  sent: Record<string, unknown>[] = []; readyState = 0; closed = false;
  onopen?: () => void; onmessage?: (event: {data: string}) => void; onclose?: () => void;
  send(data: string) { this.sent.push(JSON.parse(data)); }
  open() { this.readyState = 1; this.onopen?.(); }
  reply(value: unknown) { this.onmessage?.({data: JSON.stringify(value)}); }
  close() { this.closed = true; this.readyState = 3; this.onclose?.(); }
}
const owned: ReturnType<typeof createControlSocket>[] = [];
afterEach(() => { owned.splice(0).forEach(channel => channel.dispose()); });
function setup(token = 'A') {
  const sockets: Socket[] = [];
  const channel = createControlSocket('ws://hub/exec-ws', token, {retryMs: 10, connectTimeoutMs: 30,
    openSocket() { const ws = new Socket(); sockets.push(ws); return ws as unknown as WebSocket; },
  }); owned.push(channel);
  const ready = () => { const ws = sockets.at(-1)!; ws.open(); expect(ws.sent[0]).toEqual({token}); ws.reply({ready: true}); return ws; };
  return {channel, sockets, ready};
}
test('concurrent requests and subscriptions share one authenticated connection', async () => {
  const {channel, sockets, ready} = setup(); const data: string[] = [];
  channel.subscribe('/logs', chunk => data.push(chunk), () => {});
  const a = channel.request({action: 'A'}, 100), b = channel.request({ui: {device: 'B'}}, 100);
  expect(sockets).toHaveLength(1); const ws = ready();
  const requests = ws.sent.filter(msg => typeof msg.id === 'number');
  ws.reply({id: requests[1]!.id, ok: true}); ws.reply({id: requests[0]!.id, stdout: 'A'});
  expect((await a).stdout).toBe('A'); expect((await b).ok).toBe(true);
  const sub = ws.sent.find(msg => typeof msg.sub === 'number')!;
  ws.reply({sub: sub.sub, data: 'line'}); expect(data).toEqual(['line']);
});
test('one subscriber can unsubscribe without canceling another on the same path', () => {
  const {channel, ready} = setup(); const a: string[] = [], b: string[] = [];
  const stopA = channel.subscribe('/logs', x => a.push(x), () => {});
  channel.subscribe('/logs', x => b.push(x), () => {}); const ws = ready();
  const subs = ws.sent.filter(msg => typeof msg.sub === 'number'); stopA();
  ws.reply({sub: subs[0]!.sub, data: 'stale'}); ws.reply({sub: subs[1]!.sub, data: 'live'});
  expect(a).toEqual([]); expect(b).toEqual(['live']); expect(ws.closed).toBe(false);
});
test('each client owns its credentials, request IDs and disposal', async () => {
  const a = setup('A'), b = setup('B');
  const pa = a.channel.request({action: 'A'}, 100), pb = b.channel.request({action: 'B'}, 100);
  const wa = a.ready(), wb = b.ready();
  const rejected = pa.catch(error => error); a.channel.dispose(); expect((await rejected).message).toContain('closed');
  expect(wb.closed).toBe(false); wb.reply({id: wb.sent[1]!.id, stdout: 'B'});
  expect((await pb).stdout).toBe('B'); expect(wa.closed).toBe(true);
});
test('a dropped action rejects without replay while subscriptions reconnect', async () => {
  const {channel, sockets, ready} = setup(); const data: string[] = []; let ends = 0;
  channel.subscribe('/events', x => data.push(x), () => ends++);
  const request = channel.request({action: 'write'}, 100); const ws = ready();
  const rejected = request.catch(error => error); ws.close(); expect((await rejected).message).toContain('closed');
  await Bun.sleep(15); expect(sockets).toHaveLength(2); const fresh = ready();
  expect(fresh.sent.some(msg => msg.action === 'write')).toBe(false);
  expect(ends).toBe(1); const sub = fresh.sent.find(msg => typeof msg.sub === 'number')!;
  ws.reply({ready: true}); ws.reply({sub: sub.sub, data: 'retired'}); ws.onclose?.();
  fresh.reply({sub: sub.sub, data: 'current'}); expect(data).toEqual(['current']);
});
test('request deadlines and aborts do not cancel other requests', async () => {
  const {channel, ready} = setup(); const abort = new AbortController();
  const one = channel.request({action: 'one'}, 100, abort.signal), two = channel.request({action: 'two'}, 100);
  const ws = ready(); const rejected = one.catch(error => error); abort.abort(new Error('abort')); expect((await rejected).message).toContain('abort');
  ws.reply({id: ws.sent.find(msg => msg.action === 'two')!.id, ok: true}); expect((await two).ok).toBe(true);
  await expect(channel.request({action: 'hung'}, 10)).rejects.toThrow('timeout');
});
test('failed auth has a deadline and disposal cancels reconnects', async () => {
  const {channel, sockets} = setup();
  await expect(channel.request({action: 'hung'}, 100)).rejects.toThrow('timeout');
  expect(sockets[0]!.closed).toBe(true);
  channel.subscribe('/logs', () => {}, () => {}); channel.dispose();
  await Bun.sleep(40); expect(sockets).toHaveLength(2);
});

test('shared actions and UI requests wait for a server slot', async () => {
  const {channel, ready} = setup();
  const requests = Array.from({length: 10}, (_, n) => channel.request(
    n % 2 ? {ui: {request: n}} : {action: `write-${n}`}, 1000,
  ));
  const ws = ready();
  const sent = () => ws.sent.filter(msg => typeof msg.id === 'number');
  expect(sent()).toHaveLength(8);
  ws.reply({id: sent()[0]!.id, ok: true});
  expect(sent()).toHaveLength(9);
  ws.reply({id: sent()[1]!.id, ok: true});
  expect(sent()).toHaveLength(10);
  for (const request of sent().slice(2)) ws.reply({id: request.id, ok: true});
  expect((await Promise.all(requests)).every(reply => reply.ok)).toBe(true);
});

test('aborting a sent action keeps its server slot until the reply arrives', async () => {
  const {channel, ready} = setup();
  const abort = new AbortController();
  const first = channel.request({action: 'first'}, 1000, abort.signal).catch(error => error);
  const active = Array.from({length: 7}, (_, n) => channel.request({action: `active-${n}`}, 1000));
  const queued = channel.request({action: 'queued'}, 1000);
  const ws = ready();
  abort.abort(new Error('abandoned'));
  expect((await first).message).toBe('abandoned');
  expect(ws.sent.some(msg => msg.action === 'queued')).toBe(false);
  ws.reply({id: ws.sent.find(msg => msg.action === 'first')!.id, ok: true});
  expect(ws.sent.some(msg => msg.action === 'queued')).toBe(true);
  for (const request of ws.sent.filter(msg => typeof msg.id === 'number' && msg.action !== 'first'))
    ws.reply({id: request.id, ok: true});
  await Promise.all([...active, queued]);
});

test('queued request deadlines reject without sending an expired write', async () => {
  const {channel, ready} = setup();
  const active = Array.from({length: 8}, (_, n) => channel.request({action: `active-${n}`}, 1000));
  const queued = channel.request({action: 'expired'}, 10);
  const ws = ready();
  await expect(queued).rejects.toThrow('timeout');
  for (const request of ws.sent.filter(msg => typeof msg.id === 'number'))
    ws.reply({id: request.id, ok: true});
  await Promise.all(active);
  expect(ws.sent.some(msg => msg.action === 'expired')).toBe(false);
});
