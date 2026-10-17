import { isIP } from "node:net";

/**
 * DNS rebinding guard, a copy of serve-sim's. A page on another domain that resolves to this machine
 * is same-origin in the browser, so without a session token it could read every response and pass
 * the same-origin checks. Its requests carry that other domain in `Host`.
 *
 * Allowed: `localhost`, `*.localhost`, and IP literals (a rebinding page cannot make the browser send
 * an IP as `Host`). Other names need a session token or `--allow-any-host-when-insecure`.
 */
export function isAllowedHost(hostHeader: string | readonly string[] | undefined | null): boolean {
  // Only a client that is not a browser (HTTP/1.0, a raw socket, an in-process call) omits Host; a
  // browser always sends one, so a missing header cannot come from a rebinding page.
  if (hostHeader === undefined || hostHeader === null || hostHeader === "") return true;
  // Two Host headers (Bun's upgrade parser keeps both) name no single host.
  if (typeof hostHeader !== "string") return false;
  const hostname = hostnameOf(hostHeader);
  if (hostname === null) return false;
  // Fetch can join duplicate Host headers into one comma-separated value.
  if (!/^[a-z0-9.-]+$/.test(hostname)) return isIP(hostname) !== 0;
  if (hostname === "localhost" || hostname.endsWith(".localhost")) return true;
  return isIP(hostname) !== 0;
}

/**
 * The lowercase host name of a `Host` header, without port, brackets, or trailing dot; null when the
 * header is not a host with an optional numeric port.
 */
function hostnameOf(hostHeader: string): string | null {
  const value = hostHeader.trim().toLowerCase();
  if (value.startsWith("[")) {
    const end = value.indexOf("]");
    if (end === -1 || !isPortSuffix(value.slice(end + 1))) return null;
    return value.slice(1, end);
  }
  // More than one colon without brackets is a bare IPv6 address, which has no port.
  if (value.indexOf(":") !== value.lastIndexOf(":")) return value;
  const colon = value.indexOf(":");
  if (colon !== -1 && !isPortSuffix(value.slice(colon))) return null;
  return (colon === -1 ? value : value.slice(0, colon)).replace(/\.$/, "") || null;
}

/** Empty, or a colon and a port number. */
function isPortSuffix(suffix: string): boolean {
  return suffix === "" || /^:\d{1,5}$/.test(suffix);
}

export function refusedHostMessage(hostHeader: string): string {
  return (
    `serve-emu does not answer for the host "${hostHeader}". Open it on localhost or its IP address, ` +
    "use a session token, or answer for any name with --allow-any-host-when-insecure."
  );
}
