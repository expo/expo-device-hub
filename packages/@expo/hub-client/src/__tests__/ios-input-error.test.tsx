import { afterEach, expect, test } from 'bun:test';
import { act, create, type ReactTestRenderer } from 'react-test-renderer';

import {
  IOS_INPUT_BUSY_MESSAGE,
  IOS_INPUT_UNAVAILABLE_MESSAGE,
  iosInputCloseError,
} from '../ios-input-error';
import { type DeviceClient } from '../types';
import { ClientProbe } from './client-probe';
import { createGlobalStubs } from './test-globals';

const { stubGlobal, restoreGlobals } = createGlobalStubs();
/** The input feature's error message, or null while input works. */
const inputMessage = (client: DeviceClient) => client.input.error?.message ?? null;

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

async function renderIosClient({ inputAdmission = false } = {}) {
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
        ...(inputAdmission ? { inputAdmission: true } : {}),
      });
    }
    return Response.json({ devices: [] });
  });

  let client!: DeviceClient;
  function Harness() {
    return (
      <ClientProbe
        platform="ios"
        options={{ baseUrl: '/sim', device: 'DEVICE-A', streamMode: 'mjpeg' }}
        onClient={(next) => {
          client = next;
        }}
      />
    );
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

const SCREEN = { width: 390, height: 844, orientation: 'portrait' };
const ADMITTED_FRAME = new Uint8Array([0x83]).buffer;

async function rejectFirstSocket(options?: { inputAdmission?: boolean }) {
  const rendered = await renderIosClient(options);
  const { client, helperSockets } = rendered;
  expect(helperSockets()).toHaveLength(1);
  expect(inputMessage(client())).toBeNull();
  await act(async () => helperSockets()[0]!.onclose?.({ code: 1013, reason: CLIENT_LIMIT_REASON }));
  expect(inputMessage(client())).toBe(CLIENT_LIMIT_REASON);
  expect(client().input.status).toBe('reconnecting');
  expect(client().input.error).toMatchObject({ code: 'busy', retryable: true });
  return rendered;
}

const waitForRetry = () => act(async () => new Promise((resolve) => setTimeout(resolve, 1600)));

test('a rejected input socket reports an input error until a later socket gets a config frame', async () => {
  const { client, helperSockets } = await rejectFirstSocket();

  // A plain drop during the retry keeps the rejection visible.
  await waitForRetry();
  expect(helperSockets()).toHaveLength(2);
  await act(async () => helperSockets()[1]!.onclose?.({ code: 1006, reason: '' }));
  expect(inputMessage(client())).toBe(CLIENT_LIMIT_REASON);

  // serve-sim opens a refused socket before it closes it, so opening alone is not recovery.
  await waitForRetry();
  const refused = helperSockets()[2]!;
  refused.readyState = 1;
  await act(async () => refused.onopen?.());
  expect(inputMessage(client())).toBe(CLIENT_LIMIT_REASON);
  await act(async () => refused.onclose?.({ code: 1013, reason: CLIENT_LIMIT_REASON }));
  expect(inputMessage(client())).toBe(CLIENT_LIMIT_REASON);

  await waitForRetry();
  const admitted = helperSockets()[3]!;
  admitted.readyState = 1;
  await act(async () => admitted.onopen?.());
  expect(inputMessage(client())).toBe(CLIENT_LIMIT_REASON);
  await act(async () => admitted.onmessage?.({ data: configFrame(SCREEN) }));
  expect(inputMessage(client())).toBeNull();
});

test('on a server without admission frames, an input socket that stays open clears the input error', async () => {
  const { client, helperSockets } = await rejectFirstSocket();

  await waitForRetry();
  const admitted = helperSockets()[1]!;
  admitted.readyState = 1;
  await act(async () => admitted.onopen?.());
  expect(inputMessage(client())).toBe(CLIENT_LIMIT_REASON);
  await act(async () => new Promise((resolve) => setTimeout(resolve, 1100)));
  expect(inputMessage(client())).toBeNull();
});

test('on a server with admission frames, only the admission frame clears the input error', async () => {
  const { client, helperSockets } = await rejectFirstSocket({ inputAdmission: true });

  // The refusal close can arrive later than the legacy grace period.
  await waitForRetry();
  const refused = helperSockets()[1]!;
  refused.readyState = 1;
  await act(async () => refused.onopen?.());
  await act(async () => new Promise((resolve) => setTimeout(resolve, 1100)));
  expect(inputMessage(client())).toBe(CLIENT_LIMIT_REASON);
  await act(async () => refused.onclose?.({ code: 1013, reason: CLIENT_LIMIT_REASON }));
  expect(inputMessage(client())).toBe(CLIENT_LIMIT_REASON);

  await waitForRetry();
  const admitted = helperSockets()[2]!;
  admitted.readyState = 1;
  await act(async () => admitted.onopen?.());
  expect(inputMessage(client())).toBe(CLIENT_LIMIT_REASON);
  await act(async () => admitted.onmessage?.({ data: ADMITTED_FRAME }));
  expect(inputMessage(client())).toBeNull();
});

test('serve-sim inputUnavailable in the screen config reports an input error', async () => {
  const { client, helperSockets } = await renderIosClient();
  const socket = helperSockets()[0]!;
  socket.readyState = 1;
  await act(async () => socket.onopen?.());

  await act(async () =>
    socket.onmessage?.({
      data: configFrame({ ...SCREEN, inputUnavailable: true }),
    }),
  );
  expect(inputMessage(client())).toBe(IOS_INPUT_UNAVAILABLE_MESSAGE);
  expect(client().input.status).toBe('error');
  expect(client().input.error?.retryable).toBe(false);

  await act(async () =>
    socket.onmessage?.({
      data: configFrame({ ...SCREEN, inputUnavailable: false }),
    }),
  );
  expect(inputMessage(client())).toBeNull();
});
