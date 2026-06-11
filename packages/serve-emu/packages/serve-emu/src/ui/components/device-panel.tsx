import { useCallback, useEffect, useState } from "react";

type Device = {
  serial: string;
  state: string;
  current: boolean;
};

export function DevicePanel() {
  const [devices, setDevices] = useState<Device[]>([]);
  const [status, setStatus] = useState("Loading...");

  const refresh = useCallback(async () => {
    try {
      const res = await fetch("/api/devices", { cache: "no-store" });
      const json = await res.json() as { ok?: boolean; devices?: Device[]; error?: string };
      if (!json.ok || !json.devices) {
        setDevices([]);
        setStatus(json.error || "Unavailable");
        return;
      }
      setDevices(json.devices);
      setStatus(`${json.devices.length} device${json.devices.length === 1 ? "" : "s"}`);
    } catch (err) {
      setDevices([]);
      setStatus(err instanceof Error ? err.message : String(err));
    }
  }, []);

  useEffect(() => {
    void refresh();
    const timer = setInterval(refresh, 3000);
    return () => clearInterval(timer);
  }, [refresh]);

  return (
    <section className="tool-panel device-panel">
      <div className="panel-heading">
        <h2>Devices</h2>
        <div className="location-status">{status}</div>
      </div>
      <div className="device-list">
        {devices.length === 0 ? (
          <div className="device-empty">No adb devices reported.</div>
        ) : (
          devices.map((device) => (
            <div key={device.serial} className={device.current ? "device-row current" : "device-row"}>
              <span>{device.serial}</span>
              <code>{device.current ? "streaming" : device.state}</code>
            </div>
          ))
        )}
      </div>
      <button onClick={() => void refresh()}>Refresh Devices</button>
    </section>
  );
}
