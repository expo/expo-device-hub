// Recorder preload (REC_PRELOAD=engine-input.js) for the Agent Hub pane: sends the page's
// single-finger touches to the simstream engine, over the page's own /simstream socket, instead of
// serve-sim's HID injector, so every simstream pane injects touches through the same code.
(() => {
  const Native = window.WebSocket, phase = { begin: 'down', move: 'move', end: 'up' };
  let engine = null, seq = 0;
  window.__engineTouches = 0;
  window.WebSocket = class extends Native {
    constructor(url, protocols) { super(url, protocols); if (String(url).includes('/simstream')) engine = this; }
    send(data) {
      const b = data instanceof ArrayBuffer ? new Uint8Array(data) : data instanceof Uint8Array ? data : null;
      if (this === engine || !b || b[0] !== 0x03) return super.send(data); // 0x03: serve-sim's WS_MSG_TOUCH
      const m = JSON.parse(new TextDecoder().decode(b.subarray(1)));
      if (engine?.readyState === Native.OPEN) {
        engine.send(JSON.stringify({ t: 'touch', p: phase[m.type], x: m.x, y: m.y, seq: ++seq, edge: m.edge ?? 0 }));
        window.__engineTouches++;
      }
    }
  };
})();
