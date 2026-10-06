// Recovery paths found in the second review round, exercised through DeviceClientProvider.
import { afterEach, beforeEach, expect, test } from 'bun:test';
import { act, create, type ReactTestRenderer } from 'react-test-renderer';
import type { DeviceClient } from '../types';
import { ClientProbe } from './client-probe';
import { createGlobalStubs } from './test-globals';

const { stubGlobal, restoreGlobals } = createGlobalStubs();
let renderer: ReactTestRenderer | undefined;
let client: DeviceClient;
let requests: Array<{ url: URL; init?: RequestInit; resolve(response: Response): void }>;
class Socket {
  send() {}
  close() {}
  addEventListener() {}
  removeEventListener() {}
}
class Events {
  static instances: Events[] = [];
  onopen?: () => void;
  onerror?: () => void;
  listeners = new Map<string, (event: unknown) => void>();
  constructor(readonly url: string) {
    Events.instances.push(this);
  }
  addEventListener(name: string, listener: (event: unknown) => void) {
    this.listeners.set(name, listener);
  }
  close() {}
}
beforeEach(() => {
  requests = [];
  Events.instances = [];
  stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
  stubGlobal('window', {
    location: { href: 'https://hub.test/' },
    addEventListener() {},
    removeEventListener() {},
    setTimeout,
    clearTimeout,
    setInterval,
    clearInterval,
  });
  stubGlobal('document', { hidden: false, addEventListener() {}, removeEventListener() {} });
  stubGlobal('WebSocket', Socket);
  stubGlobal('EventSource', Events);
  stubGlobal(
    'fetch',
    (input: string | URL, init?: RequestInit) =>
      new Promise<Response>((resolve) => {
        requests.push({ url: new URL(input), init, resolve });
      }),
  );
});
afterEach(async () => {
  if (renderer) await act(async () => renderer?.unmount());
  renderer = undefined;
  restoreGlobals();
});
let clientRenders = 0;
function Harness({ device = 'a', token = 'old-token' }: { device?: string; token?: string }) {
  return (
    <ClientProbe
      platform="android"
      options={{ baseUrl: 'https://hub.test', device, token, streamMode: 'h264' }}
      onClient={(next) => {
        client = next;
        clientRenders++;
      }}
    />
  );
}
async function respond(path: string, payload: unknown, status = 200) {
  const request = requests.findLast((request) => request.url.pathname === path)!;
  expect(request).toBeDefined();
  await act(async () => request.resolve(Response.json(payload, { status })));
}
async function mount() {
  await act(async () => {
    renderer = create(<Harness />);
  });
}

test('a corrected token restarts reads that stopped on an auth failure', async () => {
  await mount();
  await respond('/api', {}, 401);
  await respond('/api/foreground', {}, 401);
  const before = requests.filter(r => r.url.pathname === '/api/foreground').length;
  await act(async () => renderer!.update(<Harness token="fixed-token" />));
  await respond('/api', {});
  const after = requests.filter(r => r.url.pathname === '/api/foreground').length;
  expect(after).toBe(before + 1);
});

test('an older location refresh does not overwrite a successful write', async () => {
  await mount();
  await respond('/api', {});
  await respond('/api/location', {emulator:true, location: {latitude:1,longitude:2}});
  await act(async () => client.location.refresh());
  const olderRead = requests.findLast(r => r.url.pathname === '/api/location')!;
  let write!: ReturnType<DeviceClient['location']['set']>;
  await act(async () => { write = client.location.set({latitude:3,longitude:4}); });
  await respond('/api/location', {ok:true, location:{latitude:3,longitude:4}});
  expect(await write).toMatchObject({ok:true});
  expect(client.location.data).toEqual({latitude:3,longitude:4});
  await act(async () => olderRead.resolve(Response.json({emulator:true, location:{latitude:1,longitude:2}})));
  expect(client.location.data).toEqual({latitude:3,longitude:4});
});

test('reattaching events after stopped polling starts a new read', async () => {
  const polls: Array<()=>void>=[];
  stubGlobal('setInterval',(callback:()=>void, delay:number)=>{if(delay===1000) polls.push(callback); return 1;});
  stubGlobal('clearInterval',()=>{});
  await mount();
  await respond('/api', {});
  await act(async () => client.events.attach());
  for(let attempt=0;attempt<3;attempt++){
    await respond('/api/session', {}, 503);
    if(attempt<2) await act(async()=>{for(const poll of polls) poll();});
  }
  expect(client.events.status).toBe('error');
  await act(async () => client.events.detach());
  const before = requests.filter(r => r.url.pathname === '/api/session').length;
  await act(async () => client.events.attach());
  const after = requests.filter(r => r.url.pathname === '/api/session').length;
  expect(after).toBe(before + 1);
});

test('stream refresh restarts the iOS MJPEG image request', async () => {
  await act(async () => {
    renderer = create(<ClientProbe platform="ios" options={{baseUrl:'https://hub.test', device:'a', streamMode:'mjpeg'}} onClient={next => {client=next;}} />);
  });
  await respond('/api', {device:'a', url:'https://hub.test/helper/a', streamUrl:'https://hub.test/helper/a/stream.mjpeg'});
  const assignments: string[] = [];
  const img = {set src(value:string){assignments.push(value);}, naturalWidth:0, naturalHeight:0, addEventListener(){}, removeEventListener(){}, removeAttribute(){}};
  await act(async () => client.stream.attachVideo(img as unknown as HTMLImageElement));
  const before = assignments.length;
  expect(before).toBeGreaterThan(0);
  await act(async () => client.stream.refresh());
  expect(assignments.length).toBeGreaterThan(before);
});

test('painted Android WebSocket video is ready even when /api fails', async () => {
  const sockets: Array<{onmessage?: (event:{data:unknown})=>void}> = [];
  stubGlobal('WebSocket', class {
    static OPEN=1; readyState=1;
    onmessage?: (event:{data:unknown})=>void;
    constructor(){sockets.push(this);}
    send(){} close(){} addEventListener(){} removeEventListener(){}
  });
  stubGlobal('VideoDecoder', class {
    state='unconfigured'; decodeQueueSize=0;
    constructor(readonly init: {output(frame:unknown):void}){}
    configure(){this.state='configured';}
    decode(){this.init.output({displayWidth:360,displayHeight:720,close(){}});}
    close(){this.state='closed';}
  });
  stubGlobal('EncodedVideoChunk', class {constructor(_:unknown){}});
  await mount();
  let painted=0;
  const canvas={tagName:'CANVAS',width:0,height:0,getContext:()=>({drawImage(){painted++;}})};
  await act(async () => client.stream.attachVideo(canvas as unknown as HTMLCanvasElement));
  await respond('/api', {}, 503);
  await act(async () => sockets[0].onmessage?.({data:new Uint8Array([0,0,1,0x67,0x42,0xe0,0x1e,0,0,1,0x65,1]).buffer}));
  expect(painted).toBe(1);
  expect(client.stream.status).toBe('ready');
  expect(client.stream.data?.screen).toEqual({width:360,height:720});
});

test('a failed location refresh keeps retrying while it reports reconnecting', async () => {
  const intervals=new Map<number,()=>void>();
  let id=0;
  stubGlobal('setInterval',(callback:()=>void)=>{intervals.set(++id,callback);return id;});
  stubGlobal('clearInterval',(key:number)=>{intervals.delete(key);});
  await mount();
  await respond('/api',{});
  await respond('/api/location',{emulator:true,location:null});
  await act(async () => client.location.refresh());
  await respond('/api/location',{},503);
  expect(client.location.status).toBe('reconnecting');
  const before=requests.filter(r=>r.url.pathname==='/api/location').length;
  await act(async () => {for(const callback of intervals.values()) callback();});
  const after=requests.filter(r=>r.url.pathname==='/api/location').length;
  expect(after).toBe(before+1);
});

test('an iOS token change reports an auth failure from rediscovery', async () => {
  const tree=(token:string)=><ClientProbe platform="ios" options={{baseUrl:'https://hub.test',device:'a',streamMode:'mjpeg',token}} onClient={next=>{client=next;}}/>;
  await act(async()=>{renderer=create(tree('first'));});
  await respond('/api',{device:'a',url:'https://hub.test/helper/a'});
  await act(async()=>renderer!.update(tree('second')));
  await respond('/api',{},401);
  expect(client.stream.status).toBe('error');
  expect(client.stream.error?.code).toBe('auth');
});

// Third review round: transport state that works without discovery.

test('a retry started during a location write cannot overwrite its successful result', async () => {
  const intervals = new Map<number, () => void>();
  let id = 0;
  stubGlobal('setInterval', (callback: () => void) => { intervals.set(++id, callback); return id; });
  stubGlobal('clearInterval', (key: number) => { intervals.delete(key); });
  await mount();
  await respond('/api', {});
  await respond('/api/location', { emulator: true, location: { latitude: 1, longitude: 2 } });
  await act(async () => client.location.refresh());
  await respond('/api/location', {}, 503);
  expect(client.location.status).toBe('reconnecting');
  let write!: ReturnType<DeviceClient['location']['set']>;
  await act(async () => { write = client.location.set({ latitude: 3, longitude: 4 }); });
  const writeRequest = requests.findLast(r => r.url.pathname === '/api/location' && r.init?.method === 'POST')!;
  expect(writeRequest).toBeDefined();
  const reads = () => requests.filter((r) => r.url.pathname === '/api/location' && !r.init?.method);
  const readsBefore = reads().length;
  // The retry that is due during the write waits for it.
  await act(async () => { for (const callback of intervals.values()) callback(); });
  expect(reads()).toHaveLength(readsBefore);
  await act(async () => writeRequest.resolve(Response.json({ ok: true, location: { latitude: 3, longitude: 4 } })));
  expect(await write).toMatchObject({ ok: true });
  expect(client.location.data).toEqual({ latitude: 3, longitude: 4 });
  // Then the deferred read runs, and it can only see the state after the write.
  expect(reads()).toHaveLength(readsBefore + 1);
  await act(async () => reads().at(-1)!.resolve(Response.json({ emulator: true, location: { latitude: 3, longitude: 4 } })));
  expect(client.location.status).toBe('ready');
  expect(client.location.data).toEqual({ latitude: 3, longitude: 4 });
});

async function videoWithoutDiscovery() {
  const sockets: Array<{ onmessage?: (event: {data: unknown}) => void; onclose?: (event: {code: number}) => void }> = [];
  stubGlobal('WebSocket', class {
    static OPEN = 1; readyState = 1;
    onmessage?: (event: { data: unknown }) => void;
    onclose?: (event: { code: number }) => void;
    constructor() { sockets.push(this); }
    send() {} close() {} addEventListener() {} removeEventListener() {}
  });
  stubGlobal('VideoDecoder', class {
    state = 'unconfigured'; decodeQueueSize = 0;
    constructor(readonly init: { output(frame: unknown): void }) {}
    configure() { this.state = 'configured'; }
    decode() { this.init.output({ displayWidth: 360, displayHeight: 720, close() {} }); }
    close() { this.state = 'closed'; }
  });
  stubGlobal('EncodedVideoChunk', class {});
  await mount();
  const canvas = { tagName: 'CANVAS', width: 0, height: 0, getContext: () => ({ drawImage() {} }) };
  await act(async () => client.stream.attachVideo(canvas as unknown as HTMLCanvasElement));
  await respond('/api', {}, 503);
  await act(async () => sockets[0].onmessage?.({ data: new Uint8Array([0,0,1,0x67,0x42,0xe0,0x1e,0,0,1,0x65,1]).buffer }));
  expect(client.stream.status).toBe('ready');
  return sockets;
}

test('input rejection is visible when video is live but discovery fails', async () => {
  const sockets = await videoWithoutDiscovery();
  await act(async () => sockets[0].onmessage?.({ data: JSON.stringify({ ok: false, error: 'Tap refused' }) }));
  expect(client.input.data?.rejected?.message).toBe('Tap refused');
});

test('a previously playing stream retains data after a drop while discovery fails', async () => {
  const sockets = await videoWithoutDiscovery();
  await act(async () => sockets[0].onclose?.({ code: 1006 }));
  expect(client.stream.status).toBe('reconnecting');
  expect(client.stream.data?.screen).toEqual({ width: 360, height: 720 });
});

test('stream refresh reconnects a live transport even before discovery succeeds', async () => {
  const sockets = await videoWithoutDiscovery();
  const before = sockets.length;
  await act(async () => client.stream.refresh());
  expect(sockets.length).toBe(before + 1);
});

test('WebSocket encoder pending state covers the write, not the initial read', async () => {
  const sockets = await videoWithoutDiscovery();
  // Retry discovery explicitly; the earlier request already failed.
  await act(async () => client.streamSettings.refresh());
  await respond('/api', {});
  expect(client.stream.status).toBe('ready');
  await respond('/api/stream-settings', { maxDimension: 1280, h264Fps: 60, h264Bitrate: 6000000 });
  await respond('/api/stream-mode', {
    mode: 'scrcpy', availableModes: ['scrcpy'], grpcImageMode: 'png', encoder: 'software', inputSource: 'scrcpy',
  });
  let write!: ReturnType<DeviceClient['streamSettings']['update']>;
  await act(async () => { write = client.streamSettings.update({ maxDimension: 720 }); });
  expect(client.stream.status).toBe('reconnecting');
  expect(client.streamSettings.writes.pending.has('maxDimension')).toBe(true);
  await respond('/api/stream-settings', {}, 503);
  expect(await write).toMatchObject({ ok: false });
  expect(client.stream.status).toBe('ready');
  expect(client.streamSettings.data?.maxDimension).toBe(1280);
  expect(sockets).toHaveLength(1);
});

test('input is unsupported when inactive and resolving before discovery', async () => {
  await act(async () => {
    renderer = create(<ClientProbe platform="android" options={{ baseUrl: 'https://hub.test', device: 'a', streamMode: 'h264', enabled: false }} onClient={next => { client = next; }} />);
  });
  expect(client.input.status).toBe('unsupported');
  expect(client.input.data).toBeUndefined();
  expect(requests).toHaveLength(0);
  await act(async () => renderer!.update(<Harness />));
  expect(client.input.status).toBe('resolving');
  expect(client.input.data).toBeUndefined();
});
