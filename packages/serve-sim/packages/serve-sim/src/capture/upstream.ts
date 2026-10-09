import { isIP } from "node:net";

export interface CaptureUpstream {
  /** Canonical HTTP proxy URL, without credentials. */
  url: string;
  /** Decoded username:password for mitmproxy's upstream Basic authentication. */
  auth?: string;
}

const hasControlCharacter = (value: string) =>
  Array.from(value).some((character) => character.charCodeAt(0) < 32 || character.charCodeAt(0) === 127);

// @ref LLP 0005#upstream-proxy — One caller-supplied HTTP proxy; no system lookup or direct fallback.
export function parseCaptureProxy(value: string | undefined): CaptureUpstream | null {
  const text = value?.trim();
  if (!text || text === "none") return null;
  const invalid = () => new Error(
    "--network-capture-proxy must be an HTTP proxy URL, such as " +
      'http://host:port or http://user:password@host:port, or "none".',
  );
  try {
    const url = new URL(text);
    if (url.protocol !== "http:" || !url.hostname || url.port === "0" ||
        url.pathname !== "/" || url.search || url.hash || hasControlCharacter(text)) throw invalid();
    const username = decodeURIComponent(url.username);
    const password = decodeURIComponent(url.password);
    if ((password && !username) || username.includes(":") || hasControlCharacter(username + password)) throw invalid();
    url.username = "";
    url.password = "";
    return { url: url.href, ...(username ? { auth: `${username}:${password}` } : {}) };
  } catch {
    // This message reaches the panel; the input can contain credentials.
    throw invalid();
  }
}

export class OwnProxyPortError extends Error {
  constructor() {
    super("The network capture upstream proxy uses the capture proxy's own port. Choose another port.");
  }
}

// @ref LLP 0005#self-proxy-protection — Reject numeric/localhost own-port aliases without a DNS lookup.
export function assertNotOwnProxy(upstream: CaptureUpstream | null, ownPort: number): void {
  if (!upstream) return;
  const url = new URL(upstream.url);
  const host = url.hostname.replace(/^\[(.*)\]$/, "$1");
  if (Number(url.port || 80) === ownPort && (isIP(host) !== 0 || /^(?:.+\.)?localhost\.?$/.test(host))) {
    throw new OwnProxyPortError();
  }
}
