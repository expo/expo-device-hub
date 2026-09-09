/**
 * Parse the state JSON that `serve-sim --detach` prints. Stdout is not always
 * pure JSON: the CLI can prepend runtime notices — ports.ts logs
 * "Port 3100 busy, killing listener pid(s): …" while it reclaims the default
 * port from a server the previous test is still tearing down. Naive
 * JSON.parse of the whole stdout therefore flakes exactly when the
 * simulator-backed e2e suites run back-to-back (worst on slow CI runners,
 * where the dying listener holds the port longest). Scan for the state line
 * instead of assuming it is the only output.
 */
export function parseDetachState<T>(stdout: string): T {
  for (const line of stdout.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed.startsWith("{")) continue;
    try {
      return JSON.parse(trimmed) as T;
    } catch {
      // A notice that merely starts with "{" — keep scanning.
    }
  }
  throw new Error(`serve-sim --detach printed no state JSON:\n${stdout}`);
}
