// Time endpoint for clock-offset measurement.
//   /      wall clock (Date.now), for the barcode harness
//   /mono  the engine's clock: Mach absolute time in ms (DispatchTime.uptimeNanoseconds on the
//          Swift side; libuv's hrtime uses the same Mach clock on macOS), for frame-header ages.
import http from 'node:http';
http.createServer((req, res) => {
  res.writeHead(200, { 'content-type': 'text/plain', 'cache-control': 'no-store', 'access-control-allow-origin': '*' });
  res.end(String(req.url.startsWith('/mono') ? Number(process.hrtime.bigint()) / 1e6 : Date.now()));
}).listen(8815, '0.0.0.0', () => console.log('time server :8815'));
