/**
 * The `--require-token` session token on the dashboard side.
 *
 * The CLI prints the dashboard link with the token as `?token=`. The dashboard
 * reads it once on load, keeps it in `sessionStorage` for this tab, and drops
 * it from the address bar so it does not stay in the history or get shared by
 * accident. `#token=` is accepted too, since a fragment never reaches a server
 * or a proxy log (the form serve-sim's own share link moved to).
 */

const STORAGE_KEY = 'expo-device-hub:access-token';

export interface AccessTokenInUrl {
  token: string | null;
  /** The same URL without the token, to put back in the address bar. */
  cleanedUrl: string;
}

/** Pull `?token=` (or `#token=`) out of a URL. Pure, so it is unit-testable. */
export function readAccessTokenFromUrl(href: string): AccessTokenInUrl {
  const url = new URL(href);
  let token = url.searchParams.get('token');
  if (token) {
    url.searchParams.delete('token');
  } else if (url.hash.length > 1) {
    const fragment = new URLSearchParams(url.hash.slice(1));
    token = fragment.get('token');
    if (token) {
      fragment.delete('token');
      const rest = fragment.toString();
      url.hash = rest ? `#${rest}` : '';
    }
  }
  return { token: token || null, cleanedUrl: url.toString() };
}

interface AccessTokenWindow {
  location: { href: string };
  history?: { state: unknown; replaceState(state: unknown, unused: string, url?: string): void };
  sessionStorage?: { getItem(key: string): string | null; setItem(key: string, value: string): void };
}

/**
 * The token for this dashboard tab, or null for an ungated Hub. A token in the
 * URL wins and is stored; otherwise the one stored earlier in this tab is used.
 */
export function dashboardAccessToken(win: AccessTokenWindow | undefined = globalWindow()): string | null {
  if (!win) return null;
  const { token, cleanedUrl } = readAccessTokenFromUrl(win.location.href);
  if (token) {
    try {
      win.sessionStorage?.setItem(STORAGE_KEY, token);
    } catch {
      // Storage can be unavailable (privacy mode); the token still works for this load.
    }
    try {
      win.history?.replaceState(win.history.state, '', cleanedUrl);
    } catch {}
    return token;
  }
  try {
    return win.sessionStorage?.getItem(STORAGE_KEY) || null;
  } catch {
    return null;
  }
}

function globalWindow(): AccessTokenWindow | undefined {
  return typeof window === 'undefined' ? undefined : (window as unknown as AccessTokenWindow);
}
