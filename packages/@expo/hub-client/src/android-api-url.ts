/**
 * Join an API path onto the base URL, **preserving any path prefix** the base
 * carries. `baseUrl` is the `expo-serve-emu` plugin mount
 * (`…/_expo/plugins/serve-emu`), so `new URL('/ws', baseUrl)` would drop
 * that prefix and miss the plugin; a plain string join keeps it (and still works
 * for a bare `http://localhost:3300` standalone serve-emu).
 */
export function apiUrl(baseUrl: string, path: string): string {
  return `${baseUrl.replace(/\/$/, "")}${path}`;
}

/** Same join, with the target device carried as a query parameter. */
export function deviceApiUrl(baseUrl: string, path: string, device: string | null): string {
  const url = new URL(apiUrl(baseUrl, path));
  if (device) url.searchParams.set("device", device);
  return url.toString();
}
