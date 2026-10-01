import { type DevicePlatform } from './types';

/**
 * A serve-sim started with `--require-token` accepts its session token as a bearer header, as
 * `?token=` where a browser cannot set a header (`<img>`, `EventSource`), and as a WebSocket
 * subprotocol, never in a socket URL. A page serve-sim served itself needs none of this: the
 * cookie it traded the link token for covers every request.
 */
export type SessionToken = string | null | undefined;

/** The subprotocol prefix each backend reads the token from. */
const SUBPROTOCOL_PREFIXES = {
  ios: 'serve-sim.token.',
} satisfies Partial<Record<DevicePlatform, string>>;

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
  platform: keyof typeof SUBPROTOCOL_PREFIXES,
  token: SessionToken,
): string[] | undefined {
  return token ? [`${SUBPROTOCOL_PREFIXES[platform]}${token}`] : undefined;
}
