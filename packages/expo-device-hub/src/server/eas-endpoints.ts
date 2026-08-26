export const READY_ROUTE = '/readyz';
export const METRICS_ROUTE = '/metrics';

interface EasEndpointOptions {
  mountPath: string;
  serveSimPrefix: string;
}

function jsonResponse(body: unknown): Response {
  return new Response(JSON.stringify(body), {
    headers: {
      'Content-Type': 'application/json; charset=utf-8',
      'Cache-Control': 'no-store',
    },
  });
}

export function handleEasEndpoint(
  request: Request,
  { mountPath, serveSimPrefix }: EasEndpointOptions
): Response | null {
  const { pathname, search } = new URL(request.url);

  if (pathname === READY_ROUTE) {
    // EAS does not currently use the device ID. A Hub can have zero to many devices
    // connected, so there is no single device ID for this interface to report.
    return jsonResponse({ status: 'ready', device: 'no-device-id' });
  }

  if (pathname === METRICS_ROUTE) {
    // TODO: This redirect is only a temporary stopgap. Implement Hub metrics properly,
    // including metrics for Android devices, instead of relying on serve-sim.
    return new Response(null, {
      status: 307,
      headers: { Location: `${mountPath}${serveSimPrefix}/metrics${search}` },
    });
  }

  return null;
}
