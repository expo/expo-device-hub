import { apiUrl } from './android-api-url';
import { ClipboardActionError } from './device-clipboard';
import { type SessionFetch } from './session-token';

export type SimulatorCopy = { text: string; cleanupWarning?: string };

// Used only when serve-sim's reply has no `error`.
const COPY_FAILURES: Readonly<Record<number, string>> = {
  // serve-sim answers 504 when the app copies no new text. Copying the text that the pasteboard
  // already holds does not change it.
  504: 'The app did not copy any new text. Select text in the app and try again.',
  409: 'The simulator has no input connection. Reconnect and try again.',
  413: 'The copied text is larger than 4 MiB.',
};

/**
 * Press Command+C in the simulator and read what the app copies, through serve-sim's
 * `POST /api/pasteboard?copy=1`. The route checks the exec token as a bearer and the browser's Origin.
 */
export async function copySimulatorText(
  baseUrl: string,
  device: string | null,
  execToken: string | null,
  fetchImpl: SessionFetch,
  signal?: AbortSignal,
): Promise<SimulatorCopy> {
  const query = device ? `?device=${encodeURIComponent(device)}&copy=1` : '?copy=1';
  let response: Response;
  try {
    response = await fetchImpl(`${apiUrl(baseUrl, '/api/pasteboard')}${query}`, {
      method: 'POST',
      cache: 'no-store',
      signal,
      ...(execToken ? { headers: { Authorization: `Bearer ${execToken}` } } : {}),
    });
  } catch {
    throw new Error('Could not reach the simulator to copy.');
  }
  const body = (await response.json().catch(() => null)) as
    | { ok?: unknown; text?: unknown; cleanupWarning?: unknown; error?: unknown }
    | null;
  if (response.ok && body?.ok === true && typeof body.text === 'string') {
    return typeof body.cleanupWarning === 'string'
      ? { text: body.text, cleanupWarning: body.cleanupWarning }
      : { text: body.text };
  }
  // A failed Copy can still leave Command held; serve-sim then sends `cleanupWarning` with the error.
  throw new ClipboardActionError(
    typeof body?.error === 'string'
      ? body.error
      : COPY_FAILURES[response.status] ?? `Could not copy from the simulator (${response.status}).`,
    typeof body?.cleanupWarning === 'string' ? body.cleanupWarning : undefined,
  );
}
