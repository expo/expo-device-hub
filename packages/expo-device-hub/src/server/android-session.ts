import { randomUUID } from 'node:crypto';
import { mkdir, rename, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

import type { createRouter } from '../../vendor/serve-emu/dist/middleware.js';
import { listAndroidEmulators } from './devices';

type RecordingRouter = Pick<
  ReturnType<typeof createRouter>,
  'startScreenRecording' | 'finishScreenRecording' | 'stopAll'
>;
type RecordingLimits = Pick<
  Parameters<RecordingRouter['startScreenRecording']>[0],
  'maxFileBytes' | 'maxDurationMs' | 'minFreeBytes'
>;

export type RecordingStart = { started: true } | { started: false; reason: string };

/** Owns one Android host lifetime; the router owns its canonical capture and muxer. */
export class AndroidSession {
  private startTask: Promise<RecordingStart> | null = null;
  private directory: string | null = null;
  private finishTask: Promise<void> | null = null;
  private shutdownTask: Promise<void> | null = null;

  constructor(
    private readonly router: RecordingRouter,
    private readonly listEmulators: typeof listAndroidEmulators = listAndroidEmulators
  ) {}

  async startRecording(directory: string, limits: RecordingLimits = {}): Promise<RecordingStart> {
    if (this.startTask || this.finishTask) {
      throw new Error('Android recording must start once, before session finalization.');
    }
    this.startTask = this.startRecordingAsync(directory, limits);
    return await this.startTask;
  }

  private async startRecordingAsync(
    directory: string,
    limits: RecordingLimits
  ): Promise<RecordingStart> {
    this.directory = directory;
    await mkdir(directory, { recursive: true });
    // Never reuse a previous session's result list.
    await writeFile(join(directory, 'recordings.json'), '[]', { flag: 'wx' });
    const { devices, error } = await this.listEmulators();
    const booted = devices.filter(device => device.booted && !device.physical);
    const device = booted[0];
    if (booted.length !== 1 || !device) {
      // Recording is best effort. The session must still start, so the empty list stays for the uploader.
      return {
        started: false,
        reason: `Android recording requires exactly one booted emulator; found ${booted.length}.${error ? ` ${error.message}` : ''}`,
      };
    }
    await this.router.startScreenRecording({
      ...limits,
      directory: join(directory, randomUUID()),
      udid: device.id,
      deviceName: device.name,
      runtimeDisplayName: device.version,
    });
    return { started: true };
  }

  finishRecording(): Promise<void> {
    return (this.finishTask ??= (async () => {
      const start = await this.startTask;
      const recording = await this.router.finishScreenRecording();
      if (start?.started && recording && this.directory) {
        const resultPath = join(this.directory, 'recordings.json');
        await writeFile(`${resultPath}.partial`, JSON.stringify([recording]));
        await rename(`${resultPath}.partial`, resultPath);
      }
    })());
  }

  shutdown(): Promise<void> {
    return (this.shutdownTask ??= (async () => {
      try {
        await this.finishRecording();
      } finally {
        await this.router.stopAll();
      }
    })());
  }
}
