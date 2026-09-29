import { type ScreenshotArtifact, type ScreenshotCapture } from './types';

type ScreenshotFetch = (input: string, init?: RequestInit) => Promise<Response>;

/** Capture a still PNG through a screenshot endpoint, along with whether it reached the session artifacts. */
export async function fetchScreenshot(
  url: string,
  fetchImpl: ScreenshotFetch = fetch,
): Promise<ScreenshotCapture | null> {
  try {
    const response = await fetchImpl(url, { method: 'POST', cache: 'no-store' });
    if (!response.ok) return null;
    return { blob: await response.blob(), artifact: screenshotArtifact(response.headers) };
  } catch {
    return null;
  }
}

/** Capture a still PNG through serve-sim's POST-only screenshot endpoint. */
export function fetchIosScreenshot(
  baseUrl: string,
  device?: string | null,
  fetchImpl: ScreenshotFetch = fetch,
): Promise<ScreenshotCapture | null> {
  const base = baseUrl.replace(/\/$/, '');
  return fetchScreenshot(
    `${base}/api/screenshot${device ? `?device=${encodeURIComponent(device)}` : ''}`,
    fetchImpl,
  );
}

function screenshotArtifact(headers: Headers): ScreenshotArtifact | null {
  const status = headers.get('X-Expo-Screenshot-Artifact');
  if (status === null) return null;
  if (status === 'failed') {
    const error = headers.get('X-Expo-Screenshot-Artifact-Error')?.trim();
    return error ? { status, error } : { status };
  }
  if (status === 'saved' || status === 'disabled') return { status };
  console.warn(`Ignoring unknown X-Expo-Screenshot-Artifact value: ${status}`);
  return null;
}
