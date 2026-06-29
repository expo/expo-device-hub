import { useDevice } from "../lib/device";

export function DevicePanel() {
  const { devices, serial, setSerial, status, refresh } = useDevice();

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
          devices.map((device) => {
            const online = device.state === "device";
            const active = device.serial === serial;
            return (
              <button
                key={device.serial}
                type="button"
                className={active ? "device-row current" : "device-row"}
                disabled={!online}
                aria-pressed={active}
                title={online ? (active ? "Streaming" : "Stream this device") : device.state}
                onClick={() => {
                  if (online && !active) setSerial(device.serial);
                }}
              >
                <span>{device.serial}</span>
                <code>{active ? "streaming" : device.state}</code>
              </button>
            );
          })
        )}
      </div>
      <button onClick={() => void refresh()}>Refresh Devices</button>
    </section>
  );
}
