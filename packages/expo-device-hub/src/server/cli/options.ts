import { parseArgs } from 'node:util';

import { parsePlatformFilter, type PlatformFilter } from '../../platform-filter';
import {
  DEFAULT_TRANSPORT,
  parseTransport,
  TRANSPORTS,
  type Transport,
} from '../../transport';

export const DEFAULT_PORT = 3400;

export const HELP = `expo-device-hub — manage iOS simulators and Android emulators from the browser

Usage: expo-device-hub [options]

Options:
  -p, --port <port>          Port to listen on (default: ${DEFAULT_PORT}, or the next available port)
      --host <host>          Host to bind (default: 127.0.0.1; use 0.0.0.0 to expose on your local network)
      --platform <platform>  Show only iOS simulators or Android emulators (ios or android)
      --transport <transport> Preferred transport: ${TRANSPORTS.join(', ')} (default: ${DEFAULT_TRANSPORT})
      --hide-sidebar         Hide the device list sidebar by default
  -h, --help                 Show this help
`;

export type CliOptions = {
  port?: number;
  host: string;
  platform?: PlatformFilter;
  transport?: Transport;
  hideSidebar: boolean;
  help: boolean;
};

export function parseCliOptions(args: string[]): CliOptions {
  let values: {
    port?: string;
    host: string;
    platform?: string;
    transport?: string;
    'hide-sidebar': boolean;
    help: boolean;
  };
  try {
    ({ values } = parseArgs({
      args,
      options: {
        port: { type: 'string', short: 'p' },
        // Bind the IPv4 loopback explicitly: 'localhost' resolves to ::1 first on
        // macOS, but serve-sim's in-process state mints 127.0.0.1 URLs, so a
        // v6-only listener leaves the advertised stream/ws endpoints unreachable.
        host: { type: 'string', default: '127.0.0.1' },
        platform: { type: 'string' },
        transport: { type: 'string' },
        'hide-sidebar': { type: 'boolean', default: false },
        help: { type: 'boolean', short: 'h', default: false },
      },
    }));
  } catch (error) {
    throw new Error(`${error instanceof Error ? error.message : error}\n\n${HELP}`);
  }

  if (values.help) return { host: values.host, help: true };

  const port = values.port !== undefined ? Number(values.port) : undefined;
  if (port !== undefined && (!Number.isInteger(port) || port < 0 || port > 65535)) {
    throw new Error(`Invalid --port: ${values.port}\n\n${HELP}`);
  }

  const platform = parsePlatformFilter(values.platform);
  if (values.platform !== undefined && platform === undefined) {
    throw new Error(`Invalid --platform: ${values.platform}\n\n${HELP}`);
  }

  const transport = parseTransport(values.transport);
  if (values.transport !== undefined && transport === undefined) {
    throw new Error(`Invalid --transport: ${values.transport}\n\n${HELP}`);
  }

  return {
    port,
    host: values.host,
    platform,
    transport,
    hideSidebar: values['hide-sidebar'],
    help: false,
  };
}
