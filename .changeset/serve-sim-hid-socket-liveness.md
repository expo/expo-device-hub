---
'@expo/serve-sim': patch
---

Free a simulator input slot when its client is gone without a WebSocket close:
on a TCP FIN, or when the client stops answering WebSocket pings. Before, such
sockets could fill all eight slots and refuse new clients with
`Simulator input unavailable; retry after other clients disconnect`.
