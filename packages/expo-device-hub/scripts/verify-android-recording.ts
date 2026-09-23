#!/usr/bin/env bun
/**
 * Live integration test for Android session recording, used by CI and local checks.
 * Starts the built Hub, connects and disconnects preview viewers, then verifies
 * authenticated or signal-driven shutdown and decodes the resulting MP4.
 * This tests local capture and finalization, not EAS uploads or website playback.
 *
 * Run after build:vendor and build:server with exactly one booted Android emulator
 * and adb, ffmpeg, and ffprobe on PATH:
 *   bun packages/expo-device-hub/scripts/verify-android-recording.ts [grpc-screenshot|scrcpy] [endpoint|signal]
 * Video, manifests, hub.log, and verification.json stay in the printed temp directory.
 */
import assert from 'node:assert/strict';
import { execFile, execFileSync, spawn } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { mkdtemp, readFile, readdir, stat, writeFile } from 'node:fs/promises';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import WebSocket from 'ws';

const source = process.argv[2] ?? 'grpc-screenshot';
assert(['grpc-screenshot', 'scrcpy'].includes(source));
const stopMode = process.argv[3] ?? 'endpoint';
assert(['endpoint', 'signal'].includes(stopMode));
const limitMode = process.argv[4] ?? 'normal';
assert(['normal', 'duration', 'bytes'].includes(limitMode));
const root = await mkdtemp(join(tmpdir(), 'android-recording-smoke-'));
const reservation = createServer();
await new Promise<void>(resolve => reservation.listen(0, '127.0.0.1', resolve));
const address = reservation.address();
assert(address && typeof address !== 'string');
const port = address.port;
await new Promise<void>(resolve => reservation.close(() => resolve()));
const token = randomBytes(32).toString('hex');
const child = spawn(
  'node',
  [
    resolve(import.meta.dir, '../dist/server/cli.mjs'),
    '--port',
    String(port),
    '--platform',
    'android',
    '--stream-source',
    source,
    '--max-dimension',
    '960',
    '--video-fps',
    '30',
    '--android-recording-directory',
    join(root, 'recordings'),
  ],
  {
    env: {
      ...process.env,
      EXPO_DEVICE_HUB_RECORDING_CONTROL_TOKEN: token,
      ...(limitMode === 'duration' ? { EXPO_DEVICE_HUB_RECORDING_MAX_DURATION_MS: '3000' } : {}),
      ...(limitMode === 'bytes' ? { EXPO_DEVICE_HUB_RECORDING_MAX_BYTES: '65536' } : {}),
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  }
);
let logs = '';
child.stdout.on('data', chunk => {
  logs += chunk;
});
child.stderr.on('data', chunk => {
  logs += chunk;
});
const exited = new Promise<number | null>((resolve, reject) => {
  child.once('error', reject);
  child.once('exit', code => resolve(code));
});
const base = `http://127.0.0.1:${port}`;
const health = async () => {
  const response = await fetch(`${base}/vendor/serve-emu/health`);
  if (!response.ok) throw new Error(await response.text());
  return await response.json();
};
let socket: WebSocket | undefined;
// The byte limit trips only once fragments land, and a fragment closes at a keyframe. An
// idle CI screen yields no frames, so bytes mode swipes the screen until the limit trips.
let activity: ReturnType<typeof setInterval> | undefined;
if (limitMode === 'bytes') {
  let direction = 1;
  let swiping = false;
  activity = setInterval(() => {
    if (swiping) return;
    swiping = true;
    const [from, to] = direction > 0 ? ['800', '200'] : ['200', '800'];
    direction = -direction;
    execFile('adb', ['shell', 'input', 'swipe', '270', from, '270', to, '200'], () => {
      swiping = false;
    });
  }, 500);
  activity.unref();
}
try {
  const deadline = Date.now() + 45_000;
  while (true) {
    if (child.exitCode !== null) throw new Error(`Hub exited during startup: ${logs}`);
    try {
      const response = await fetch(`${base}/readyz`);
      if (response.ok) break;
    } catch {}
    if (Date.now() > deadline) throw new Error(`Hub did not become ready: ${logs}`);
    await delay(100);
  }
  const initial = await health();
  assert.equal(initial.clients, 0);
  if (limitMode === 'normal') assert.equal(initial.screenRecording.status, 'recording');
  await delay(3_000);
  const beforeViewer = await health();
  assert.equal(beforeViewer.clients, 0);
  if (limitMode === 'normal') assert(beforeViewer.screenRecording.frames > 0);

  for (let visit = 0; visit < 2; visit++) {
    const viewer = new WebSocket(`${base.replace('http:', 'ws:')}/vendor/serve-emu/ws`);
    socket = viewer;
    await new Promise<void>((resolve, reject) => {
      const timeout = setTimeout(() => reject(new Error('No preview video received')), 10_000);
      viewer.on('message', (_data, isBinary) => {
        if (isBinary) {
          clearTimeout(timeout);
          resolve();
        }
      });
      viewer.once('error', reject);
    });
    await delay(1_000);
    socket.close();
    await delay(3_000);
    const betweenVisits = await health();
    assert.equal(betweenVisits.clients, 0);
    if (limitMode === 'normal') {
      assert.equal(
        betweenVisits.screenRecording.firstFrameAt,
        initial.screenRecording.firstFrameAt
      );
      assert.equal(betweenVisits.screenRecording.status, 'recording');
    }
  }
  const afterViewer = await health();
  assert.equal(afterViewer.clients, 0);
  if (limitMode === 'normal') {
    assert.equal(afterViewer.screenRecording.firstFrameAt, initial.screenRecording.firstFrameAt);
    assert.equal(afterViewer.screenRecording.status, 'recording');
  } else if (limitMode === 'duration') {
    assert.equal(afterViewer.screenRecording.status, 'complete');
  } else {
    const limitDeadline = Date.now() + 60_000;
    let current = afterViewer;
    while (current.screenRecording.status !== 'failed') {
      assert(Date.now() < limitDeadline, `Byte limit not reached: ${JSON.stringify(current)}`);
      await delay(1_000);
      current = await health();
    }
    clearInterval(activity);
  }

  if (limitMode === 'normal') {
    const sourceChange = await fetch(`${base}/vendor/serve-emu/api/stream-mode`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ mode: source === 'scrcpy' ? 'grpc-screenshot' : 'scrcpy' }),
    });
    assert.equal(sourceChange.status, 409, await sourceChange.text());
    const settingsChange = await fetch(`${base}/vendor/serve-emu/api/stream-settings`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ maxDimension: 720 }),
    });
    assert.equal(settingsChange.status, 409, await settingsChange.text());
  }
  const stopUrl = `${base}/_eas/android-recording/stop`;
  assert.equal((await fetch(stopUrl, { method: 'POST' })).status, 401);
  const headers = { Authorization: `Bearer ${token}` };
  assert.equal((await fetch(stopUrl, { headers })).status, 405);
  const stoppingAt = Date.now();
  if (stopMode === 'endpoint') {
    for (let i = 0; i < 2; i++) {
      const response = await fetch(stopUrl, {
        method: 'POST',
        headers,
        signal: AbortSignal.timeout(60_000),
      });
      assert.equal(response.status, limitMode === 'bytes' ? 500 : 200, await response.text());
    }
  }
  child.kill('SIGTERM');
  const shutdownDeadline = setTimeout(() => child.kill('SIGKILL'), 65_000);
  const exitCode = await exited;
  clearTimeout(shutdownDeadline);
  assert.equal(exitCode, limitMode === 'bytes' ? 1 : 0, logs);
  const results = JSON.parse(await readFile(join(root, 'recordings/recordings.json'), 'utf8'));
  if (limitMode === 'bytes') {
    assert.deepEqual(results, []);
    const sessions = await readdir(join(root, 'recordings'), { withFileTypes: true });
    const session = sessions.find(entry => entry.isDirectory());
    assert(session, 'Failed recording retains its session directory');
    const directory = join(root, 'recordings', session.name);
    const manifest = JSON.parse(await readFile(join(directory, 'session.json'), 'utf8'));
    assert.equal(manifest.status, 'failed');
    assert.match(manifest.error, /byte limit/);
    const bytes = (await stat(join(directory, 'recording.mp4.partial'))).size;
    assert(bytes <= 65536, 'Partial MP4 exceeded the byte limit');
    const report = {
      source,
      stopMode,
      limitMode,
      root,
      bytes,
      status: manifest.status,
      previewVisits: 2,
    };
    await writeFile(join(root, 'verification.json'), JSON.stringify(report, null, 2));
    console.log(JSON.stringify(report, null, 2));
  } else {
    assert.equal(results.length, 1);
    const manifest = JSON.parse(await readFile(join(results[0].directory, 'session.json'), 'utf8'));
    assert.equal(manifest.status, 'complete');
    if (initial.screenRecording.firstFrameAt) {
      assert.equal(manifest.firstFrameWallClock.iso8601, initial.screenRecording.firstFrameAt);
    }
    assert.equal(manifest.stopReason, limitMode === 'duration' ? 'duration-limit' : 'session-stop');
    const mp4 = join(results[0].directory, manifest.recording);
    const probe = JSON.parse(
      execFileSync(
        'ffprobe',
        ['-v', 'error', '-show_streams', '-show_format', '-of', 'json', mp4],
        {
          encoding: 'utf8',
        }
      )
    );
    const duration = Number(probe.format.duration);
    const wallDuration = (stoppingAt - Date.parse(manifest.firstFrameWallClock.iso8601)) / 1000;
    const expectedDuration = limitMode === 'duration' ? 3 : wallDuration;
    const durationTolerance = limitMode === 'duration' ? 0.5 : 1;
    assert(
      Math.abs(duration - expectedDuration) < durationTolerance,
      `MP4 ${duration}s vs expected ${expectedDuration}s`
    );
    assert.equal(probe.streams[0].width, manifest.width);
    assert.equal(probe.streams[0].height, manifest.height);
    const packets = JSON.parse(
      execFileSync('ffprobe', ['-v', 'error', '-show_packets', '-of', 'json', mp4], {
        encoding: 'utf8',
      })
    ).packets;
    // Fragmented MP4 keeps sample durations in each fragment header; ffprobe reports them as N/A per packet.
    let lastPts = -1;
    for (const packet of packets) {
      assert(Number(packet.pts_time) > lastPts, 'Packet timestamps must increase');
      lastPts = Number(packet.pts_time);
    }
    execFileSync('ffmpeg', [
      '-v',
      'error',
      '-xerror',
      '-i',
      mp4,
      '-f',
      'null',
      '-',
    ]);
    const report = {
      source,
      stopMode,
      limitMode,
      root,
      mp4,
      duration,
      wallDuration,
      frames: manifest.frames,
      firstFrameAt: manifest.firstFrameWallClock.iso8601,
      viewersBefore: initial.clients,
      viewersAfter: afterViewer.clients,
    };
    await writeFile(join(root, 'verification.json'), JSON.stringify(report, null, 2));
    console.log(JSON.stringify(report, null, 2));
  }
} finally {
  clearInterval(activity);
  socket?.terminate();
  if (child.exitCode === null) {
    child.kill('SIGTERM');
    const timeout = setTimeout(() => child.kill('SIGKILL'), 65_000);
    await exited;
    clearTimeout(timeout);
  }
  await writeFile(join(root, 'hub.log'), logs);
  console.log(`Artifacts retained at ${root}`);
}
