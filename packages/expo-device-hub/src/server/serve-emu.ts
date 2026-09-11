import { randomUUID } from 'node:crypto';
import { mkdir, rename, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

// @ts-ignore vendored module, absent until `bun run build:vendor`
import {
  cameraLaunchArgs,
  createRouter,
  fromWsSocket,
  seedCameraFeeds,
  type WsWebSocketLike,
} from '../../vendor/serve-emu/dist/middleware.js';

import { type EmulatorCameraFeeds } from './device-actions';
import { listAndroidEmulators } from './devices';
import {
  readStandaloneServeEmuOptions,
  SERVE_EMU_OPTIONS_ENV,
  serveEmuWebSocketOptions,
} from './serve-emu-options';

export const EMU_PREFIX = '/vendor/serve-emu';

const serveEmuOptions = readStandaloneServeEmuOptions(process.env[SERVE_EMU_OPTIONS_ENV]);
const router = createRouter(serveEmuOptions);

export const emuCameraFeeds: EmulatorCameraFeeds = {
  launchArgs: cameraLaunchArgs,
  seedPlaceholders: seedCameraFeeds,
};

let recordingDirectory: string | null = null;
let shutdownTask: Promise<void> | null = null;
let finishTask: Promise<void> | null = null;

export async function startAndroidScreenRecording(directory: string): Promise<void> {
  const { devices, error } = await listAndroidEmulators();
  const booted = devices.filter(device => device.booted && !device.physical);
  const device = booted[0];
  if (booted.length !== 1 || !device) {
    throw new Error(
      `Android recording requires exactly one booted emulator; found ${booted.length}.${error ? ` ${error.message}` : ''}`
    );
  }
  await mkdir(directory, { recursive: true });
  // Reserve the result file exclusively so a previous session cannot be uploaded accidentally.
  await writeFile(join(directory, 'recordings.json'), '[]', { flag: 'wx' });
  recordingDirectory = directory;
  await router.startScreenRecording({
    directory: join(directory, randomUUID()),
    udid: device.id,
    deviceName: device.name,
    runtimeDisplayName: device.version,
  });
}

export function finishAndroidScreenRecording(): Promise<void> {
  return (finishTask ??= (async () => {
    const recording = await router.finishScreenRecording();
    if (recordingDirectory && recording) {
      const resultPath = join(recordingDirectory, 'recordings.json');
      await writeFile(`${resultPath}.partial`, JSON.stringify([recording]));
      await rename(`${resultPath}.partial`, resultPath);
    }
  })());
}

export function shutdownAndroid(): Promise<void> {
  if (shutdownTask) return shutdownTask;
  shutdownTask = (async () => {
    try {
      await finishAndroidScreenRecording();
    } finally {
      await router.stopAll();
    }
  })();
  return shutdownTask;
}

// Preserve embedded-host cleanup. The CLI awaits the same shutdown promise before exiting.
for (const signal of ['SIGINT', 'SIGTERM'] as const) {
  process.once(signal, () => {
    void shutdownAndroid().catch(() => {});
  });
}
process.once('exit', () => {
  void router.stopAll();
});

export function handleEmuRequest(request: Request): Promise<Response> {
  const url = new URL(request.url);
  const rest = `${url.pathname.slice(EMU_PREFIX.length) || '/'}${url.search}`;
  const forwarded = new Request(`${url.origin}${rest}`, request);
  return router.handleRequest(forwarded);
}

async function attachEmuSocket(socket: WsWebSocketLike, request: Request): Promise<void> {
  const url = new URL(request.url);
  let serial: string;
  try {
    serial = (await router.ensure(url.searchParams.get('device'))).serial;
  } catch {
    try {
      socket.close();
    } catch {}
    return;
  }
  const { video, frameMeta } = serveEmuWebSocketOptions(url);
  router.attachWebSocket(fromWsSocket(socket), { serial, video, frameMeta });
}

export const emuWebSocketHandler = (socket: WsWebSocketLike, request: Request): void => {
  void attachEmuSocket(socket, request);
};
