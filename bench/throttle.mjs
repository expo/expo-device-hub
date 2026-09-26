// Minimal link emulator: TCP proxy that caps downstream bandwidth and adds one-way delay each way,
// with real backpressure (stops reading from the server when its queue is full, like a bottleneck link).
import net from 'node:net';
const [listen, target, mbps, delayMs, jitterMs = 0, stallEveryMs = 0, stallMs = 0] = process.argv.slice(2).map(Number);
const bytesPerMs = (mbps * 1e6) / 8 / 1000;
net.createServer((client) => {
  const server = net.connect(target, '127.0.0.1');
  server.setNoDelay(true); client.setNoDelay(true);
  client.on('data', (d) => setTimeout(() => server.write(d), delayMs));            // upstream: delay only
  let lastDeliverAt = 0; const delivery = [];  // jitter without reordering: each chunk leaves no earlier than the one before
  const queue = []; let queued = 0, credit = 0, lastTick = performance.now(), inFlight = 0, serverDone = false;
  const maybeFinish = () => { if (serverDone && !queue.length && !inFlight && !finished) { finished = true; clearInterval(timer); client.end(); } };
  let finished = false;
  server.on('data', (d) => { queue.push(d); queued += d.length; if (queued > 256 * 1024) server.pause(); });
  const timer = setInterval(() => {                                                  // downstream: rate + delay
    const now = performance.now(); credit = Math.min(credit + (now - lastTick) * bytesPerMs, 64 * 1024); lastTick = now;
    while (queue.length && credit >= 1) {
      let chunk = queue[0];
      const n = Math.floor(credit);
      if (chunk.length > n) { queue[0] = chunk.subarray(n); chunk = chunk.subarray(0, n); } else queue.shift();
      credit -= chunk.length; queued -= chunk.length;
      inFlight++;
      const at = Math.max(lastDeliverAt, performance.now() + delayMs + Math.random() * jitterMs); lastDeliverAt = at;
      delivery.push({ at, chunk });
    }
    if (queued < 128 * 1024) server.resume();
    // One ordered delivery line (per-chunk timers can fire out of order and corrupt the stream).
    const t = performance.now();
    // Periodic stalls, like a TCP retransmit on a lossy wireless hop: nothing is delivered for stallMs.
    if (stallEveryMs && (t % stallEveryMs) < stallMs) return;
    while (delivery.length && delivery[0].at <= t) { client.write(delivery.shift().chunk); inFlight--; }
    maybeFinish();
  }, 1);
  const end = () => { clearInterval(timer); client.destroy(); server.destroy(); };
  client.on('close', end); client.on('error', end); server.on('error', end);
  server.on('end', () => { serverDone = true; maybeFinish(); });
}).listen(listen, () => console.log(`throttle :${listen} → :${target} at ${mbps} Mbps, ${delayMs} ms each way`));
