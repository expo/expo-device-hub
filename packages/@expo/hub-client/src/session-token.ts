import { type DevicePlatform } from './types';

/**
 * A Hub or serve-sim started with `--require-token` accepts its session token as a bearer header,
 * as `?token=` where a browser cannot set a header (`<img>`, `EventSource`), and as a WebSocket
 * subprotocol, never in a socket URL. serve-emu's router (`createRouter({ sessionToken })`), which
 * the Hub mounts, takes the same three forms. The standalone `serve-emu --token` server is
 * different: it takes a bearer header, `?token=`, or its own cookie, but no subprotocol. A page the
 * server served itself needs none of this: the cookie it traded the link token for covers every
 * request.
 */
export type SessionToken = string | null | undefined;

/** The subprotocol prefix each backend reads the token from. */
const SUBPROTOCOL_PREFIXES: Record<DevicePlatform, string> = {
  ios: 'serve-sim.token.',
  android: 'serve-emu.token.',
};

export type SessionFetch = (input: RequestInfo | URL, init?: RequestInit) => Promise<Response>;

/** `fetch` that sends the token as a bearer header. Plain `fetch` without a token. */
export function sessionTokenFetch(token: SessionToken): SessionFetch {
  if (!token) return (input, init) => fetch(input, init);
  return (input, init) => {
    const headers = new Headers(init?.headers ?? (input instanceof Request ? input.headers : undefined));
    headers.set('Authorization', `Bearer ${token}`);
    return fetch(input, { ...init, headers });
  };
}

/** `url` with the token as `?token=`, for a request that cannot carry a header. */
export function withSessionTokenQuery(url: string, token: SessionToken): string {
  if (!token) return url;
  return `${url}${url.includes('?') ? '&' : '?'}token=${encodeURIComponent(token)}`;
}

/** WebSocket subprotocols that carry the token to `platform`'s backend; none without a token. */
export function sessionTokenProtocols(
  platform: DevicePlatform,
  token: SessionToken,
): string[] | undefined {
  return token ? [`${SUBPROTOCOL_PREFIXES[platform]}${token}`] : undefined;
}
