import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { networkInterfaces } from 'node:os';
import { parseArgs } from 'node:util';
import { WebSocketServer } from 'ws';
import { URL } from 'node:url';

import { requestOrigin, toFetchRequest, toUpgradeRequest, writeFetchResponse } from './cli/node-fetch-server';
import { staticFileHandler } from './cli/static-files';

type HubServerModule = typeof import('./index');
type WebSocketRouteHandler = (socket: unknown, request: Request, server: WebSocketServer) => void;

const DEFAULT_PORT = 3400;

const HELP = `expo-device-hub — manage iOS simulators and Android emulators from the browser

Usage: expo-device-hub [options]

Options:
  -p, --port <port>  Port to listen on (default: ${DEFAULT_PORT}, or the next available port)
      --host <host>  Host to bind (default: localhost; use 0.0.0.0 to expose on your local network)
  -h, --help         Show this help
`;

function fail(message: string): never {
  console.error(message);
  process.exit(1);
}

/** First non-internal IPv4 address, for the Network URL when bound to a wildcard host. */
function lanAddress(): string | undefined {
  for (const addresses of Object.values(networkInterfaces())) {
    for (const address of addresses ?? []) {
      if (!address.internal && address.family === 'IPv4') {
        return address.address;
      }
    }
  }
  return undefined;
}

/** Resolves true once listening, false if the port is taken, rejects on any other error. */
function tryListen(server: Server, port: number, host: string): Promise<boolean> {
  return new Promise((resolve, reject) => {
    const onError = (error: NodeJS.ErrnoException) => {
      server.removeListener('listening', onListening);
      if (error.code === 'EADDRINUSE') {
        resolve(false);
      } else {
        reject(error);
      }
    };
    const onListening = () => {
      server.removeListener('error', onError);
      resolve(true);
    };
    server.once('error', onError);
    server.once('listening', onListening);
    server.listen(port, host);
  });
}

async function main(): Promise<void> {
  let values: { port?: string; host: string; help: boolean };
  try {
    ({ values } = parseArgs({
      options: {
        port: { type: 'string', short: 'p' },
        host: { type: 'string', default: 'localhost' },
        help: { type: 'boolean', short: 'h', default: false },
      },
    }));
  } catch (error) {
    fail(`${error instanceof Error ? error.message : error}\n\n${HELP}`);
  }
  if (values.help) {
    console.log(HELP);
    return;
  }

  const explicitPort = values.port !== undefined ? Number(values.port) : undefined;
  if (explicitPort !== undefined && (!Number.isInteger(explicitPort) || explicitPort < 0 || explicitPort > 65535)) {
    fail(`Invalid --port: ${values.port}\n\n${HELP}`);
  }

  process.env.EXPO_DEVICE_HUB_BASE_PATH = '';
  // @ts-ignore — built sibling of this bundle (dist/server/index.mjs), kept external at build time
  const hubServer = (await import('./index.mjs')) as HubServerModule;
  const handler = hubServer.default;

  const serveStaticFile = staticFileHandler(new URL('../client/', import.meta.url));

  const server = createServer(async (req, res) => {
    try {
      const request = toFetchRequest(req);
      const response = await handler(request);
      if (response) {
        writeFetchResponse(response, res);
        return;
      }
      if (req.method === 'GET' && (await serveStaticFile(req, res))) return;
      writeFetchResponse(new Response('Not Found', { status: 404 }), res);
    } catch (error) {
      console.error(error);
      if (res.headersSent) {
        res.destroy();
      } else {
        writeFetchResponse(new Response('Internal Server Error', { status: 500 }), res);
      }
    }
  });

  // Pre-listen errors are handled by tryListen (EADDRINUSE retry) — only fail
  // hard on errors that surface after we are actually serving.
  server.on('error', (error) => {
    if (server.listening) fail(String(error));
  });

  const webSocketRoutes = new Map<string, WebSocketServer>();
  for (const [route, wsHandler] of Object.entries(
    hubServer.webSocketHandlers as Record<string, WebSocketRouteHandler>,
  )) {
    const normalizedRoute = route.startsWith('/') ? route : `/${route}`;
    const wss = new WebSocketServer({ noServer: true });
    wss.on('connection', (socket, request) =>
      wsHandler(socket, toUpgradeRequest(request, normalizedRoute), wss),
    );
    webSocketRoutes.set(normalizedRoute, wss);
  }

  server.on('upgrade', (request, socket, head) => {
    const pathname = new URL(request.url ?? '/', requestOrigin(request)).pathname;
    const wss = webSocketRoutes.get(pathname);
    if (!wss) {
      socket.destroy();
      return;
    }
    wss.handleUpgrade(request, socket, head, (ws) => wss.emit('connection', ws, request));
  });

  // The server module's own SIGINT/SIGTERM cleanup hooks (e.g. serve-emu's
  // stopAll) suppress the default exit — re-establish it once they have run.
  for (const signal of ['SIGINT', 'SIGTERM'] as const) {
    process.on(signal, () => {
      server.close();
      process.exit(0);
    });
  }

  if (explicitPort !== undefined) {
    if (!(await tryListen(server, explicitPort, values.host))) {
      fail(`Port ${explicitPort} is already in use — pick another with --port.`);
    }
  } else {
    let candidate = DEFAULT_PORT;
    while (!(await tryListen(server, candidate, values.host))) {
      candidate++;
      if (candidate > 65535) {
        fail(`No available port found starting from ${DEFAULT_PORT}.`);
      }
    }
  }

  const boundPort = (server.address() as AddressInfo).port;
  const isLoopback = values.host === 'localhost' || values.host === '127.0.0.1' || values.host === '::1';
  const isWildcard = values.host === '0.0.0.0' || values.host === '::';
  console.log('Expo Device Hub ready\n');
  if (isLoopback || isWildcard) {
    console.log(`  Local:   http://localhost:${boundPort}`);
  }
  if (isWildcard) {
    console.log(`  Network: http://${lanAddress() ?? values.host}:${boundPort}`);
  } else if (isLoopback) {
    console.log('  Network: pass --host 0.0.0.0 to expose on your local network');
  } else {
    console.log(`  Network: http://${values.host}:${boundPort}`);
  }
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
