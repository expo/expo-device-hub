// @ref LLP 0014#redaction — the same header rules as serve-sim's capture, so a credential that
// serve-sim hides on iOS is hidden in the Network panel on both platforms.
// The rules are copied from serve-sim's src/capture/redact.ts, which serve-sim does not export and
// the Hub cannot import (it ships serve-sim vendored). network-redact.test.ts keeps the copies equal.

const REDACTED = "[REDACTED]";

const SENSITIVE_HEADER_NAMES = new Set([
  "cookie2",
  "set-cookie2",
  "x-firebase-appcheck",
  "x-amz-content-sha256",
]);

const SENSITIVE_HEADER_PATTERN =
  /(^|[-_])(auth|authz|token|secret|password|passwd|credential|session|cookie|key|apikey|api[-_]?key|access[-_]?key|private[-_]?key|signature|bearer)([-_]|$)/i;

const SENSITIVE_HEADER_PREFIX_PATTERN =
  /(^|[-_])(authorization|authentication|sessionid|oidc|jwt|principal|assertion)/i;

const SENSITIVE_HEADER_SUBSTRING_PATTERN = /(token|secret|passw|credential|cookie|session)/i;

export function isSensitiveHeaderName(name: string): boolean {
  const lower = name.toLowerCase();
  return (
    SENSITIVE_HEADER_NAMES.has(lower) ||
    SENSITIVE_HEADER_PATTERN.test(lower) ||
    SENSITIVE_HEADER_PREFIX_PATTERN.test(lower) ||
    SENSITIVE_HEADER_SUBSTRING_PATTERN.test(lower)
  );
}

/** Copy `headers` with the values of credential-bearing names replaced. Values become strings. */
export function redactHeaders(headers: Record<string, unknown>): Record<string, string> {
  return Object.fromEntries(
    Object.entries(headers).map(([name, value]) => [
      name,
      isSensitiveHeaderName(name) ? REDACTED : String(value),
    ]),
  );
}
