import { afterEach, expect, test } from 'bun:test';
import { act, create, type ReactTestRenderer } from 'react-test-renderer';

import {
  IOS_INPUT_BUSY_MESSAGE,
  IOS_INPUT_UNAVAILABLE_MESSAGE,
  iosInputCloseError,
} from '../ios-input-error';
import { type DeviceClient } from '../types';
import { useIosDeviceClient } from '../useIosDevice';
import { createGlobalStubs } from './test-globals';

const { stubGlobal, restoreGlobals } = createGlobalStubs();

let renderer: ReactTestRenderer | undefined;
afterEach(async () => {
  if (renderer) await act(async () => renderer?.unmount());
  renderer = undefined;
  restoreGlobals();
});

const CLIENT_LIMIT_REASON = 'Simulator input unavailable; retry after other clients disconnect';

test('only a serve-sim 1013 close rejects input', () => {
  expect(iosInputCloseError(1013, CLIENT_LIMIT_REASON)).toBe(CLIENT_LIMIT_REASON);
  expect(iosInputCloseError(1013, '')).toBe(IOS_INPUT_BUSY_MESSAGE);
  expect(iosInputCloseError(1000, '')).toBeNull();
  expect(iosInputCloseError(1006, '')).toBeNull();
});

type FakeSocket = {
  url: string;
  readyState: number;
  onopen?: () => void;
  onmessage?: (event: { data: unknown }) => void;
  onclose?: (event: { code: number; reason: string }) => void;
};

async function renderIosClient() {
  const sockets: FakeSocket[] = [];
  stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
  stubGlobal('window', {
    location: {
      href: 'http://localhost:3200/',
      origin: 'http://localhost:3200',
      protocol: 'http:',
      host: 'localhost:3200',
    },
    addEventListener() {},
    removeEventListener() {},
    setTimeout,
    clearTimeout,
  });
  stubGlobal('document', { hidden: false, addEventListener() {}, removeEventListener() {} });
  stubGlobal('WebSocket', class {
    readyState = 0;
    constructor(readonly url: string) {
      sockets.push(this);
    }
    send() {}
    close() {}
  });
  stubGlobal('EventSource', class {
    close() {}
  });
  stubGlobal('fetch', async (url: string) => {
    if (url === '/sim/api?device=DEVICE-A') {
      return Response.json({
        device: 'DEVICE-A',
        url: 'http://localhost:3200/sim/helper/DEVICE-A',
        streamUrl: 'http://localhost:3200/sim/helper/DEVICE-A/stream.mjpeg',
        wsUrl: 'ws://localhost:3200/sim/helper/DEVICE-A/ws',
      });
    }
    return Response.json({ devices: [] });
  });

  let client!: DeviceClient;
  function Harness() {
    client = useIosDeviceClient({ baseUrl: '/sim', device: 'DEVICE-A', streamMode: 'mjpeg' });
    return null;
  }
  await act(async () => {
    renderer = create(<Harness />);
  });
  const helperSockets = () => sockets.filter((socket) => socket.url.includes('/helper/'));
  return { client: () => client, helperSockets };
}

function configFrame(config: object): ArrayBuffer {
  const json = new TextEncoder().encode(JSON.stringify(config));
  const bytes = new Uint8Array(1 + json.length);
  bytes[0] = 0x82;
  bytes.set(json, 1);
  return bytes.buffer;
}

test('a rejected input socket reports inputError until a later socket opens', async () => {
  const { client, helperSockets } = await renderIosClient();
  expect(helperSockets()).toHaveLength(1);
  expect(client().inputError).toBeNull();

  await act(async () => helperSockets()[0]!.onclose?.({ code: 1013, reason: CLIENT_LIMIT_REASON }));
  expect(client().inputError).toBe(CLIENT_LIMIT_REASON);

  // A plain drop during the retry keeps the rejection visible.
  await act(async () => new Promise((resolve) => setTimeout(resolve, 1600)));
  expect(helperSockets()).toHaveLength(2);
  await act(async () => helperSockets()[1]!.onclose?.({ code: 1006, reason: '' }));
  expect(client().inputError).toBe(CLIENT_LIMIT_REASON);

  await act(async () => new Promise((resolve) => setTimeout(resolve, 1600)));
  const socket = helperSockets()[2]!;
  socket.readyState = 1;
  await act(async () => socket.onopen?.());
  expect(client().inputError).toBeNull();
});

test('serve-sim inputUnavailable in the screen config reports inputError', async () => {
  const { client, helperSockets } = await renderIosClient();
  const socket = helperSockets()[0]!;
  socket.readyState = 1;
  await act(async () => socket.onopen?.());

  await act(async () =>
    socket.onmessage?.({
      data: configFrame({ width: 390, height: 844, orientation: 'portrait', inputUnavailable: true }),
    }),
  );
  expect(client().inputError).toBe(IOS_INPUT_UNAVAILABLE_MESSAGE);

  await act(async () =>
    socket.onmessage?.({
      data: configFrame({ width: 390, height: 844, orientation: 'portrait', inputUnavailable: false }),
    }),
  );
  expect(client().inputError).toBeNull();
});
