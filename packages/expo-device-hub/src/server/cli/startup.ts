export type StartupAddress = {
  host: string;
  port: number;
  /** First non-internal IPv4 address, for the Network link when bound to a wildcard host. */
  lanAddress?: string;
  /** Set under `--require-token`. The links carry it, since only the operator is told it. */
  sessionToken?: string;
  /** `--frame-ancestor` origins given without `--require-token`, which apply only under it. */
  ignoredFrameAncestors?: readonly string[];
};

/** What the CLI prints once it listens, in the shape serve-sim prints for `--require-token`. */
export function startupMessage({
  host,
  port,
  lanAddress,
  sessionToken,
  ignoredFrameAncestors = [],
}: StartupAddress): string {
  const isLoopback = host === 'localhost' || host === '127.0.0.1' || host === '::1';
  const isWildcard = host === '0.0.0.0' || host === '::';
  const link = (hostname: string) =>
    `http://${hostname}:${port}${sessionToken ? `/?token=${sessionToken}` : ''}`;

  const lines = ['Expo Device Hub ready', ''];
  if (isLoopback || isWildcard) {
    lines.push(`  Local:   ${link('localhost')}`);
  }
  if (isWildcard) {
    lines.push(`  Network: ${link(lanAddress ?? host)}`);
  } else if (isLoopback) {
    lines.push('  Network: pass --host 0.0.0.0 to expose on your local network');
  } else {
    lines.push(`  Network: ${link(host)}`);
  }

  if (!isLoopback) {
    lines.push(
      '',
      sessionToken
        ? '  This Hub is listening on the network. The links above carry a token because anyone ' +
            'who has it can control the devices, read captured traffic, and run commands on this machine. ' +
            'These links use plain http. On a network you do not trust, anyone who can watch the traffic ' +
            'can read the token, so put the Hub behind an https proxy or tunnel there.'
        : '  This Hub is listening on the network with no token required. Anyone who can reach it ' +
            'can control the devices and run commands on this machine. Pass --require-token to gate it.'
    );
  }
  if (ignoredFrameAncestors.length > 0) {
    lines.push('', '  --frame-ancestor has no effect without --require-token.');
  }
  return lines.join('\n');
}
