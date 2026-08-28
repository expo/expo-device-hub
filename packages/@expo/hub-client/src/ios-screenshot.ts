type ScreenshotFetch = (input: string, init?: RequestInit) => Promise<Response>;

/** Capture a still PNG through serve-sim's POST-only screenshot endpoint. */
export async function fetchIosScreenshot(
  baseUrl: string,
  device?: string | null,
  fetchImpl: ScreenshotFetch = fetch,
): Promise<Blob | null> {
  const base = baseUrl.replace(/\/$/, '');
  const url = `${base}/api/screenshot${device ? `?device=${encodeURIComponent(device)}` : ''}`;

  try {
    const response = await fetchImpl(url, { method: 'POST', cache: 'no-store' });
    if (!response.ok) return null;
    return await response.blob();
  } catch {
    return null;
  }
}
