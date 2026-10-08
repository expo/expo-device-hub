import { createRoot } from "react-dom/client";
import Dashboard from "../../src/Dashboard";

// Use the production dashboard and client. Instrumentation observes browser
// transports; it does not replace React, WebRTC, WebSockets or client methods.
const Peer = window.RTCPeerConnection;
window.__hubE2E = { peers: [], errors: [], statsReads: 0 };
window.addEventListener("error", (event) => window.__hubE2E.errors.push(event.message));
window.addEventListener("unhandledrejection", (event) =>
  window.__hubE2E.errors.push(String(event.reason)),
);
window.RTCPeerConnection = class extends Peer {
  constructor(configuration?: RTCConfiguration) {
    super(configuration);
    window.__hubE2E.peers.push(this);
    const read = this.getStats.bind(this);
    this.getStats = (...args) => {
      window.__hubE2E.statsReads++;
      return read(...args);
    };
  }
};
createRoot(document.getElementById("root")!).render(<Dashboard />);

if (new URL(location.href).searchParams.has("run")) {
  void import("./scenarios").then(({ runScenarios }) => runScenarios());
}
