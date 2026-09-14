import { randomUUID } from 'node:crypto';
import { mkdir, rename, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

import type { createRouter } from '../../vendor/serve-emu/dist/middleware.js';
import { listAndroidEmulators } from './devices';

type RecordingRouter = Pick<
  ReturnType<typeof createRouter>,
  'startScreenRecording' | 'finishScreenRecording' | 'stopAll'
>;

/** Owns one Android host lifetime; the router owns its canonical capture and muxer. */
export class AndroidSession {
  private startTask: Promise<string> | null = null;
  private finishTask: Promise<void> | null = null;
  private shutdownTask: Promise<void> | null = null;

  constructor(
    private readonly router: RecordingRouter,
    private readonly listEmulators: typeof listAndroidEmulators = listAndroidEmulators
  ) {}

  async startRecording(directory: string): Promise<void> {
    if (this.startTask || this.finishTask) {
      throw new Error('Android recording must start once, before session finalization.');
    }
    this.startTask = this.startRecordingAsync(directory);
    await this.startTask;
  }

  private async startRecordingAsync(directory: string): Promise<string> {
    const { devices, error } = await this.listEmulators();
    const booted = devices.filter(device => device.booted && !device.physical);
    const device = booted[0];
    if (booted.length !== 1 || !device) {
      throw new Error(
        `Android recording requires exactly one booted emulator; found ${booted.length}.${error ? ` ${error.message}` : ''}`
      );
    }
    await mkdir(directory, { recursive: true });
    // Never reuse a previous session's result list.
    await writeFile(join(directory, 'recordings.json'), '[]', { flag: 'wx' });
    await this.router.startScreenRecording({
      directory: join(directory, randomUUID()),
      udid: device.id,
      deviceName: device.name,
      runtimeDisplayName: device.version,
    });
    return directory;
  }

  finishRecording(): Promise<void> {
    return (this.finishTask ??= (async () => {
      const directory = await this.startTask;
      const recording = await this.router.finishScreenRecording();
      if (directory && recording) {
        const resultPath = join(directory, 'recordings.json');
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
