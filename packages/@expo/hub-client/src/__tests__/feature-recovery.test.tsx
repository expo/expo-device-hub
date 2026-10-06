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
