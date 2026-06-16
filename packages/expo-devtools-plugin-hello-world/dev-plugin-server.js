/**
 * DevTools plugin server entry point. Expo CLI calls the default-exported handler for every
 * request to `/_expo/plugins/expo-devtools-plugin-hello-world/*` with the plugin prefix
 * stripped from the URL. Return a `Response`, or `null` to fall through to static
 * `webpageRoot` serving.
 */
module.exports = async function handler(request) {
  const url = new URL(request.url);

  if (url.pathname === '/api/hello') {
    return new Response(
      JSON.stringify({
        message: `Hello from the plugin server! You sent a ${request.method} request.`,
        time: new Date().toISOString(),
      }),
      { status: 200, headers: { 'Content-Type': 'application/json' } }
    );
  }

  return null;
};

/**
 * Optional WebSocket handlers. The fetch-based handler above cannot serve WebSocket upgrades, so
 * Expo CLI mounts each entry as a WebSocket endpoint under the plugin's URL — here at
 * `/_expo/plugins/expo-devtools-plugin-hello-world/ws`. Each handler receives the connected
 * socket (the standard `ws` `WebSocket`), the upgrade request, and the `WebSocketServer` (use
 * `server.clients` to broadcast).
 */
module.exports.webSocketHandlers = {
  '/ws': (socket) => {
    socket.send(
      JSON.stringify({ type: 'welcome', message: 'Connected to the Hello World plugin server.' })
    );
    socket.on('message', (data) => {
      socket.send(JSON.stringify({ type: 'echo', message: data.toString() }));
    });
  },
};
