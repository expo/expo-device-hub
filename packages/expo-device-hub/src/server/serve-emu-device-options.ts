import { execFile } from 'node:child_process';

const ADB_QUERY_TIMEOUT_MS = 2_000;
const ADB_MUTATION_TIMEOUT_MS = 5_000;
const MAX_CONCURRENT_ADB_COMMANDS = 4;
const MAX_JSON_BODY_BYTES = 8 * 1024;

let activeAdbCommands = 0;
const adbWaiters: Array<() => void> = [];

export type NetworkRadioStatus = 'enabled' | 'disabled' | 'unknown';

export interface NetworkStatus {
  enabled: boolean | null;
  wifi: NetworkRadioStatus;
  mobileData: NetworkRadioStatus;
  raw: {
    wifi: string;
    mobileData: string;
  };
}

export interface FontScaleStatus {
  scale: number;
  raw: string;
}

export interface ReduceMotionStatus {
  enabled: boolean;
  raw: {
    transition: string;
    window: string;
    animator: string;
  };
}

export interface HighTextContrastStatus {
  enabled: boolean;
  raw: string;
}

export interface AdbCommandResult {
  status: number | null;
  stdout: string;
  stderr: string;
  error?: Error | null;
}

export type AdbRunner = (
  args: readonly string[],
  options: { timeout: number },
) => Promise<AdbCommandResult>;

async function withAdbSlot<T>(run: () => Promise<T>): Promise<T> {
  if (activeAdbCommands >= MAX_CONCURRENT_ADB_COMMANDS) {
    await new Promise<void>((resolve) => adbWaiters.push(resolve));
  } else {
    activeAdbCommands++;
  }
  try {
    return await run();
  } finally {
    const next = adbWaiters.shift();
    if (next) next();
    else activeAdbCommands--;
  }
}

const runSystemAdb: AdbRunner = (args, options) =>
  withAdbSlot(
    () =>
      new Promise((resolve) => {
        execFile(
          'adb',
          [...args],
          {
            encoding: 'utf8',
            killSignal: 'SIGKILL',
            maxBuffer: 8 * 1024 * 1024,
            timeout: options.timeout,
          },
          (error, stdout, stderr) => {
            const code =
              error && 'code' in error && typeof error.code === 'number' ? error.code : null;
            resolve({ status: error ? code : 0, stdout, stderr, error });
          },
        );
      }),
  );

async function runAdb(
  serial: string,
  args: readonly string[],
  runner: AdbRunner,
  timeout: number,
): Promise<string> {
  const result = await runner(['-s', serial, 'shell', ...args], { timeout });
  if (result.status !== 0) {
    const detail = (
      result.stderr ||
      result.stdout ||
      result.error?.message ||
      'adb command failed'
    ).trim();
    throw new Error(`adb shell ${args.join(' ')} failed: ${detail}`);
  }
  return result.stdout.trim();
}

function radioStatusFromSetting(raw: string): NetworkRadioStatus {
  if (raw === '1') return 'enabled';
  if (raw === '0') return 'disabled';
  return 'unknown';
}

/** Mirrors serve-emu's `/api/network` status calculation. */
export async function getNetworkStatus(
  serial: string,
  runner: AdbRunner = runSystemAdb,
): Promise<NetworkStatus> {
  const [wifiRaw, mobileDataRaw] = await Promise.all([
    runAdb(serial, ['settings', 'get', 'global', 'wifi_on'], runner, ADB_QUERY_TIMEOUT_MS),
    runAdb(serial, ['settings', 'get', 'global', 'mobile_data'], runner, ADB_QUERY_TIMEOUT_MS),
  ]);
  const wifi = radioStatusFromSetting(wifiRaw);
  const mobileData = radioStatusFromSetting(mobileDataRaw);
  const knownRadios = [wifi, mobileData].filter((radio) => radio !== 'unknown');
  const enabled =
    knownRadios.length === 0 ? null : knownRadios.some((radio) => radio === 'enabled');
  return {
    enabled,
    wifi,
    mobileData,
    raw: { wifi: wifiRaw, mobileData: mobileDataRaw },
  };
}

/** Toggle both Android radios, matching serve-emu's own device panel. */
export async function setNetworkEnabled(
  serial: string,
  enabled: boolean,
  runner: AdbRunner = runSystemAdb,
): Promise<NetworkStatus> {
  const action = enabled ? 'enable' : 'disable';
  await runAdb(serial, ['svc', 'wifi', action], runner, ADB_MUTATION_TIMEOUT_MS);
  await runAdb(serial, ['svc', 'data', action], runner, ADB_MUTATION_TIMEOUT_MS);
  return getNetworkStatus(serial, runner);
}

/** Read Android's numeric `settings system font_scale` value. */
export async function getFontScale(
  serial: string,
  runner: AdbRunner = runSystemAdb,
): Promise<FontScaleStatus> {
  const raw = await runAdb(
    serial,
    ['settings', 'get', 'system', 'font_scale'],
    runner,
    ADB_QUERY_TIMEOUT_MS,
  );
  const scale = Number(raw);
  if (!Number.isFinite(scale) || scale <= 0) {
    throw new Error(`Could not parse font_scale output: ${raw}`);
  }
  return { scale, raw };
}

/** Write the numeric scale format accepted by serve-emu (0.7 through 2.0). */
export async function setFontScale(
  serial: string,
  scale: number,
  runner: AdbRunner = runSystemAdb,
): Promise<FontScaleStatus> {
  if (!Number.isFinite(scale) || scale < 0.7 || scale > 2) {
    throw new Error('font scale must be between 0.7 and 2.0');
  }
  const normalized = scale.toFixed(2).replace(/0+$/, '').replace(/\.$/, '');
  await runAdb(
    serial,
    ['settings', 'put', 'system', 'font_scale', normalized],
    runner,
    ADB_MUTATION_TIMEOUT_MS,
  );
  return getFontScale(serial, runner);
}

/** Android's "Remove animations" toggle moves all three scales, so read and write them as one. */
const ANIMATION_SCALE_KEYS = [
  'transition_animation_scale',
  'window_animation_scale',
  'animator_duration_scale',
] as const;

/** Mirrors React Native's `AccessibilityInfoModule`, which is on only at exactly zero. */
function reduceMotionFromScale(raw: string): boolean {
  return raw !== '' && Number(raw.replace(',', '.')) === 0;
}

/** Mirrors React Native's `AccessibilityInfoModule`, which is on for any non-zero int. */
function highTextContrastFromSetting(raw: string): boolean {
  return /^[+-]?\d+$/.test(raw) && Number(raw) !== 0;
}

/** Read the animation scales, with `transition_animation_scale` as the authority. */
export async function getReduceMotion(
  serial: string,
  runner: AdbRunner = runSystemAdb,
): Promise<ReduceMotionStatus> {
  const [transitionRaw, windowRaw, animatorRaw] = await Promise.all(
    ANIMATION_SCALE_KEYS.map((key) =>
      runAdb(serial, ['settings', 'get', 'global', key], runner, ADB_QUERY_TIMEOUT_MS),
    ),
  );
  return {
    enabled: reduceMotionFromScale(transitionRaw),
    raw: { transition: transitionRaw, window: windowRaw, animator: animatorRaw },
  };
}

/** Write `0` to disable animations and `1` to restore the Android defaults. */
export async function setReduceMotion(
  serial: string,
  enabled: boolean,
  runner: AdbRunner = runSystemAdb,
): Promise<ReduceMotionStatus> {
  const value = enabled ? '0' : '1';
  for (const key of ANIMATION_SCALE_KEYS) {
    await runAdb(
      serial,
      ['settings', 'put', 'global', key, value],
      runner,
      ADB_MUTATION_TIMEOUT_MS,
    );
  }
  return getReduceMotion(serial, runner);
}

/** Read Android's `settings secure high_text_contrast_enabled` flag. */
export async function getHighTextContrast(
  serial: string,
  runner: AdbRunner = runSystemAdb,
): Promise<HighTextContrastStatus> {
  const raw = await runAdb(
    serial,
    ['settings', 'get', 'secure', 'high_text_contrast_enabled'],
    runner,
    ADB_QUERY_TIMEOUT_MS,
  );
  return { enabled: highTextContrastFromSetting(raw), raw };
}

/** Write the flag as the `1` or `0` int Android's `Settings.Secure` stores. */
export async function setHighTextContrast(
  serial: string,
  enabled: boolean,
  runner: AdbRunner = runSystemAdb,
): Promise<HighTextContrastStatus> {
  await runAdb(
    serial,
    ['settings', 'put', 'secure', 'high_text_contrast_enabled', enabled ? '1' : '0'],
    runner,
    ADB_MUTATION_TIMEOUT_MS,
  );
  return getHighTextContrast(serial, runner);
}

async function readJsonBody(request: Request): Promise<unknown> {
  const contentLength = Number(request.headers.get('content-length') ?? '0');
  if (Number.isFinite(contentLength) && contentLength > MAX_JSON_BODY_BYTES) {
    throw new Error('request body too large');
  }
  if (!request.body) throw new Error('request body is required');

  const reader = request.body.getReader();
  const chunks: Uint8Array[] = [];
  let length = 0;
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    length += value.byteLength;
    if (length > MAX_JSON_BODY_BYTES) {
      await reader.cancel();
      throw new Error('request body too large');
    }
    chunks.push(value);
  }
  const bytes = new Uint8Array(length);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return JSON.parse(new TextDecoder().decode(bytes));
}

function errorResponse(error: unknown): Response {
  return Response.json(
    { ok: false, error: error instanceof Error ? error.message : String(error) },
    { status: 400 },
  );
}

/**
 * Compatibility routes for controls present on serve-emu main but not yet on
 * its Expo/WebRTC branch. The response contract intentionally matches
 * serve-emu so the client needs no branch-specific behavior.
 */
export async function handleServeEmuDeviceOptionRequest(
  request: Request,
  serial: string,
  runner: AdbRunner = runSystemAdb,
): Promise<Response | null> {
  const { pathname } = new URL(request.url);

  if (pathname === '/api/network') {
    if (request.method === 'GET') {
      try {
        return Response.json({ ok: true, network: await getNetworkStatus(serial, runner) });
      } catch (error) {
        return errorResponse(error);
      }
    }
    if (request.method === 'POST') {
      try {
        const payload = await readJsonBody(request);
        if (typeof payload !== 'object' || payload === null || Array.isArray(payload)) {
          throw new Error('network payload must be an object');
        }
        const enabled = (payload as Record<string, unknown>).enabled;
        if (typeof enabled !== 'boolean') throw new Error('enabled must be a boolean');
        return Response.json({
          ok: true,
          network: await setNetworkEnabled(serial, enabled, runner),
        });
      } catch (error) {
        return errorResponse(error);
      }
    }
    return new Response('method not allowed', { status: 405 });
  }

  if (pathname === '/api/font-scale') {
    if (request.method === 'GET') {
      try {
        return Response.json({ ok: true, fontScale: await getFontScale(serial, runner) });
      } catch (error) {
        return errorResponse(error);
      }
    }
    if (request.method === 'POST') {
      try {
        const payload = await readJsonBody(request);
        if (typeof payload !== 'object' || payload === null || Array.isArray(payload)) {
          throw new Error('font scale payload must be an object');
        }
        const scale = Number((payload as Record<string, unknown>).scale);
        if (!Number.isFinite(scale) || scale < 0.7 || scale > 2) {
          throw new Error('scale must be a number between 0.7 and 2.0');
        }
        return Response.json({
          ok: true,
          fontScale: await setFontScale(serial, scale, runner),
        });
      } catch (error) {
        return errorResponse(error);
      }
    }
    return new Response('method not allowed', { status: 405 });
  }

  if (pathname === '/api/reduce-motion') {
    if (request.method === 'GET') {
      try {
        return Response.json({ ok: true, reduceMotion: await getReduceMotion(serial, runner) });
      } catch (error) {
        return errorResponse(error);
      }
    }
    if (request.method === 'POST') {
      try {
        const payload = await readJsonBody(request);
        if (typeof payload !== 'object' || payload === null || Array.isArray(payload)) {
          throw new Error('reduce motion payload must be an object');
        }
        const enabled = (payload as Record<string, unknown>).enabled;
        if (typeof enabled !== 'boolean') throw new Error('enabled must be a boolean');
        return Response.json({
          ok: true,
          reduceMotion: await setReduceMotion(serial, enabled, runner),
        });
      } catch (error) {
        return errorResponse(error);
      }
    }
    return new Response('method not allowed', { status: 405 });
  }

  if (pathname === '/api/high-text-contrast') {
    if (request.method === 'GET') {
      try {
        return Response.json({
          ok: true,
          highTextContrast: await getHighTextContrast(serial, runner),
        });
      } catch (error) {
        return errorResponse(error);
      }
    }
    if (request.method === 'POST') {
      try {
        const payload = await readJsonBody(request);
        if (typeof payload !== 'object' || payload === null || Array.isArray(payload)) {
          throw new Error('high text contrast payload must be an object');
        }
        const enabled = (payload as Record<string, unknown>).enabled;
        if (typeof enabled !== 'boolean') throw new Error('enabled must be a boolean');
        return Response.json({
          ok: true,
          highTextContrast: await setHighTextContrast(serial, enabled, runner),
        });
      } catch (error) {
        return errorResponse(error);
      }
    }
    return new Response('method not allowed', { status: 405 });
  }

  return null;
}
