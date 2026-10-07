import { timingSafeEqual } from 'node:crypto';

import type { RecordingFinish } from './android-session';

export const READY_ROUTE = '/readyz';
export const METRICS_ROUTE = '/metrics';
export const ANDROID_RECORDING_STOP_ROUTE = '/_eas/android-recording/stop';

interface EasEndpointOptions {
  mountPath: string;
  serveSimPrefix: string;
}

interface AndroidRecordingStopOptions {
  /** Bearer token EAS must present to stop the recording. Absent means the route is closed. */
  recordingControlToken?: string;
  finishAndroidRecording: () => Promise<RecordingFinish>;
}

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: {
      'Content-Type': 'application/json; charset=utf-8',
      'Cache-Control': 'no-store',
    },
  });
}

export function handleEasEndpoint(
  request: Request,
  { mountPath, serveSimPrefix }: EasEndpointOptions
): Response | null {
  const { pathname, search } = new URL(request.url);

  if (pathname === READY_ROUTE) {
    // EAS does not currently use the device ID. A Hub can have zero to many devices
    // connected, so there is no single device ID for this interface to report.
    return jsonResponse({ status: 'ready', device: 'no-device-id' });
  }

  if (pathname === METRICS_ROUTE) {
    // TODO: This redirect is only a temporary stopgap. Implement Hub metrics properly,
    // including metrics for Android devices, instead of relying on serve-sim.
    return new Response(null, {
      status: 307,
      headers: { Location: `${mountPath}${serveSimPrefix}/metrics${search}` },
    });
  }

  return null;
}

/**
 * Only the standalone CLI routes this, because only it records. Expo CLI exits without waiting
 * for a plugin to finish its MP4, so the Hub as a DevTools plugin never starts a recording.
 */
export function handleAndroidRecordingStop(
  request: Request,
  { recordingControlToken, finishAndroidRecording }: AndroidRecordingStopOptions
): Promise<Response> | Response | null {
  if (new URL(request.url).pathname !== ANDROID_RECORDING_STOP_ROUTE) return null;
  const supplied = Buffer.from(request.headers.get('authorization') ?? '');
  const expected = Buffer.from(`Bearer ${recordingControlToken}`);
  if (
    !recordingControlToken ||
    supplied.length !== expected.length ||
    !timingSafeEqual(supplied, expected)
  ) {
    return jsonResponse({ ok: false, error: 'Unauthorized' }, 401);
  }
  if (request.method !== 'POST') {
    return jsonResponse({ ok: false, error: 'Method Not Allowed' }, 405);
  }
  return finishAndroidRecording().then(
    finish =>
      finish.recorded
        ? jsonResponse({ ok: true })
        : jsonResponse({ ok: false, error: finish.reason }, 409),
    error => jsonResponse({ ok: false, error: String(error) }, 500)
  );
}
