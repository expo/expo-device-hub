import { createRoot } from "react-dom/client";
import { App } from "./app";
import { DeviceProvider } from "./lib/device";
import "./styles.css";

const root = document.getElementById("root");
if (!root) throw new Error("missing #root");
createRoot(root).render(
  <DeviceProvider>
    <App />
  </DeviceProvider>,
);
