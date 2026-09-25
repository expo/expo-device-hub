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

export function isSensitiveHeaderName(name: string): boolean {
  const lower = name.toLowerCase();
  return (
    SENSITIVE_HEADER_NAMES.has(lower)
    || SENSITIVE_HEADER_PATTERN.test(lower)
    || SENSITIVE_HEADER_PREFIX_PATTERN.test(lower)
  );
}

export function redactHeaders(headers: Record<string, string>): Record<string, string> {
  return Object.fromEntries(
    Object.entries(headers).map(([name, value]) => [name, isSensitiveHeaderName(name) ? REDACTED : value]),
  );
}
