import { isIP } from 'node:net';

import { ALLOW_ANY_HOST, ALLOW_ANY_HOST_ENV } from './allow-any-host';

export { ALLOW_ANY_HOST };


/**
 * DNS rebinding guard, as serve-sim's and serve-emu's. A page on another domain that resolves to
 * this machine is same-origin in the browser, so without a session token it could read every
 * response and pass the same-origin checks. Its requests carry that other domain in `Host`. The
 * token check stops it instead, because such a page has no token.
 */
export function hostAllowed(
  host: string | null,
  token: string | undefined,
  allowAnyHost = ALLOW_ANY_HOST,
): boolean {
  return !!token || allowAnyHost || isAllowedHost(host);
}

/**
 * A copy of serve-sim's `isAllowedHost`: `localhost`, `*.localhost`, and IP literals (a rebinding
 * page cannot make the browser send an IP as `Host`). A missing Host cannot come from a browser.
 */
export function isAllowedHost(hostHeader: string | null): boolean {
  if (hostHeader === null || hostHeader === '') return true;
  const hostname = hostnameOf(hostHeader);
  if (hostname === null) return false;
  // Fetch can join duplicate Host headers into one comma-separated value.
  if (!/^[a-z0-9.-]+$/.test(hostname)) return isIP(hostname) !== 0;
  if (hostname === 'localhost' || hostname.endsWith('.localhost')) return true;
  return isIP(hostname) !== 0;
}

/** The lowercase host name of a `Host` header, without port, brackets, or trailing dot. */
function hostnameOf(hostHeader: string): string | null {
  const value = hostHeader.trim().toLowerCase();
  if (value.startsWith('[')) {
    const end = value.indexOf(']');
    if (end === -1 || !isPortSuffix(value.slice(end + 1))) return null;
    return value.slice(1, end);
  }
  // More than one colon without brackets is a bare IPv6 address, which has no port.
  if (value.indexOf(':') !== value.lastIndexOf(':')) return value;
  const colon = value.indexOf(':');
  if (colon !== -1 && !isPortSuffix(value.slice(colon))) return null;
  return (colon === -1 ? value : value.slice(0, colon)).replace(/\.$/, '') || null;
}

function isPortSuffix(suffix: string): boolean {
  return suffix === '' || /^:\d{1,5}$/.test(suffix);
}

export function refusedHostMessage(host: string): string {
  return (
    `Expo Device Hub does not answer for the host "${host}". Open it on localhost or its IP address, ` +
    `start it with --require-token, or allow any host with --allow-any-host-when-insecure ` +
    `(${ALLOW_ANY_HOST_ENV}=1 under Expo CLI).`
  );
}
