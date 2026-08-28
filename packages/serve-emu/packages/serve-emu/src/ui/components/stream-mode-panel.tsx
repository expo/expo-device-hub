import { useCallback, useEffect, useRef, useState } from "react";
import { useApi } from "../lib/device";

type StreamMode = "scrcpy" | "grpc-screenshot";

type StreamModeResponse = {
  ok?: boolean;
  mode?: StreamMode;
  availableModes?: StreamMode[];
  error?: string;
};

const OPTIONS: { label: string; description: string; mode: StreamMode }[] = [
  { label: "Scrcpy", description: "On-device", mode: "scrcpy" },
  { label: "gRPC screenshot", description: "Host-side", mode: "grpc-screenshot" },
];

const isStreamMode = (value: unknown): value is StreamMode =>
  value === "scrcpy" || value === "grpc-screenshot";

export function StreamModePanel() {
  const api = useApi();
  const requestId = useRef(0);
  const [mode, setMode] = useState<StreamMode | null>(null);
  const [availableModes, setAvailableModes] = useState<StreamMode[]>([]);
  const [loadedSerial, setLoadedSerial] = useState<string | null>(null);
  const [status, setStatus] = useState("Loading…");
  const [busy, setBusy] = useState(false);

  const applyResponse = useCallback((data: StreamModeResponse, serial: string) => {
    setMode(isStreamMode(data.mode) ? data.mode : null);
    setAvailableModes(
      Array.isArray(data.availableModes) ? data.availableModes.filter(isStreamMode) : [],
    );
    setLoadedSerial(serial);
  }, []);

  const load = useCallback(async () => {
    const id = ++requestId.current;
    setBusy(false);
    setMode(null);
    setAvailableModes([]);
    setLoadedSerial(null);
    if (!api.serial) {
      setStatus("Waiting for device");
      return;
    }

    setStatus("Loading…");
    try {
      const res = await api.fetch("/api/stream-mode", { cache: "no-store" });
      const data = (await res.json()) as StreamModeResponse;
      if (!res.ok || !data.ok) throw new Error(data.error || `HTTP ${res.status}`);
      if (id !== requestId.current) return;
      applyResponse(data, api.serial);
      setStatus("Ready");
    } catch (err) {
      if (id !== requestId.current) return;
      setMode(null);
      setAvailableModes([]);
      setLoadedSerial(null);
      setStatus(err instanceof Error ? err.message : String(err));
    }
  }, [api, applyResponse]);

  useEffect(() => {
    void load();
    return () => {
      requestId.current++;
    };
  }, [load]);

  const apply = useCallback(
    async (next: StreamMode) => {
      if (busy || next === mode || !api.serial || loadedSerial !== api.serial) return;
      const id = ++requestId.current;
      setBusy(true);
      setStatus("Switching…");
      try {
        const res = await api.fetch("/api/stream-mode", {
          method: "PUT",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ mode: next }),
        });
        const data = (await res.json()) as StreamModeResponse;
        if (!res.ok || !data.ok) throw new Error(data.error || `HTTP ${res.status}`);
        if (id !== requestId.current) return;
        applyResponse(data, api.serial);
        setStatus("Ready");
      } catch (err) {
        if (id !== requestId.current) return;
        setStatus(err instanceof Error ? err.message : String(err));
      } finally {
        if (id === requestId.current) setBusy(false);
      }
    },
    [api, applyResponse, busy, loadedSerial, mode],
  );

  const selectionReady = Boolean(api.serial && loadedSerial === api.serial);
  const grpcAvailable = availableModes.includes("grpc-screenshot");
  const help = !api.serial
    ? "Select a device to choose its stream source."
    : !selectionReady
      ? status === "Loading…"
        ? "Checking the available stream sources…"
        : "Stream source details are unavailable."
      : !grpcAvailable
        ? "gRPC screenshot requires an Android Emulator device."
        : mode === "grpc-screenshot"
          ? "Frames and input travel through the emulator host gRPC endpoint."
          : "Frames and input travel through the scrcpy server on the device.";

  return (
    <section className="tool-panel stream-mode-panel">
      <div className="panel-heading">
        <h2>Stream source</h2>
        <div className="location-status" aria-live="polite">
          {status}
        </div>
      </div>
      <fieldset className="stream-mode-fieldset" aria-describedby="stream-mode-help">
        <legend className="visually-hidden">Stream source</legend>
        <div className="stream-mode-options">
          {OPTIONS.map((option) => {
            const disabled =
              busy ||
              !api.serial ||
              !selectionReady ||
              !availableModes.includes(option.mode);
            return (
              <label className="stream-mode-option" key={option.mode}>
                <input
                  type="radio"
                  name="stream-mode"
                  value={option.mode}
                  checked={mode === option.mode}
                  disabled={disabled}
                  onChange={() => void apply(option.mode)}
                />
                <span>
                  <strong>{option.label}</strong>
                  <small>{option.description}</small>
                </span>
              </label>
            );
          })}
        </div>
      </fieldset>
      <p className="stream-mode-help" id="stream-mode-help">
        {help}
      </p>
    </section>
  );
}
