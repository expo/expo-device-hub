// The port clients reach the preview server on. Under Bun that is the front server's port, not
// the internal listener that accepted the request. Behind a tunnel the Host header names the
// public host without a port, so the request URL alone cannot tell the middleware which local
// port to write into a device's state.
const localPorts = new WeakMap<Request, number>();

export function rememberLocalPort(request: Request, port: number | undefined): Request {
  if (port) localPorts.set(request, port);
  return request;
}

export function localPortOf(request: Request): number | undefined {
  return localPorts.get(request);
}
