// A wildcard needs two labels after the star, which stops a bare TLD like `*.com`.
const WILDCARD_HOST = /^\*\.[a-z0-9-]+(?:\.[a-z0-9-]+)+$/i;

/** Whether `value` is a `--cors-origin` wildcard such as `https://*.expo.dev`. */
export function isWildcardOrigin(value: string): boolean {
  try {
    return WILDCARD_HOST.test(new URL(value).hostname);
  } catch {
    return false;
  }
}
