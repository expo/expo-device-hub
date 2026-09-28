import http from 'node:http';
http.createServer((req, res) => { res.writeHead(200, { 'content-type': 'text/plain', 'cache-control': 'no-store' }); res.end(String(Date.now())); })
  .listen(8815, '0.0.0.0', () => console.log('time server :8815'));
