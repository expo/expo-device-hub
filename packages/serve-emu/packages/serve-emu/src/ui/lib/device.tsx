import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useState,
  type ReactNode,
} from "react";

export type Device = {
  serial: string;
  /** adb connection state: "device", "offline", "unauthorized", … */
  state: string;
  /** Whether the server currently has a live scrcpy app for this device. */
  streaming?: boolean;
};

type DevicesResponse = {
  ok?: boolean;
  devices?: Device[];
  /** Serial the server would stream by default (first available). */
  defaultSerial?: string | null;
  error?: string;
};

type DeviceContextValue = {
  devices: Device[];
  /** The device the UI is currently streaming / driving. */
  serial: string | null;
  setSerial: (serial: string) => void;
  status: string;
  refresh: () => Promise<void>;
};

const DeviceContext = createContext<DeviceContextValue | null>(null);

const POLL_INTERVAL_MS = 3000;

const isOnline = (device: Device) => device.state === "device";

/**
 * Tracks the adb device fleet (polled from the device-independent
 * `/api/devices` endpoint) and which device the UI is actively streaming.
 * Selection starts on the server's default (first available) and only changes
 * when the user picks another device or the active one disconnects.
 */
export function DeviceProvider({ children }: { children: ReactNode }) {
  const [devices, setDevices] = useState<Device[]>([]);
  const [serial, setSerial] = useState<string | null>(null);
  const [status, setStatus] = useState("Loading…");

  const refresh = useCallback(async () => {
    try {
      // `/api/devices` is a fleet endpoint — it must NOT carry `?device=`.
      const res = await fetch("/api/devices", { cache: "no-store" });
      const json = (await res.json()) as DevicesResponse;
      if (!json.ok || !json.devices) {
        setDevices([]);
        setStatus(json.error || "Unavailable");
        return;
      }
      const list = json.devices;
      setDevices(list);
      setStatus(`${list.length} device${list.length === 1 ? "" : "s"}`);
      setSerial((current) => {
        // Keep a still-connected selection; otherwise fall back to the server
        // default (first available), then any online device.
        if (current && list.some((d) => d.serial === current && isOnline(d))) return current;
        return json.defaultSerial ?? list.find(isOnline)?.serial ?? null;
      });
    } catch (err) {
      setDevices([]);
      setStatus(err instanceof Error ? err.message : String(err));
    }
  }, []);

  useEffect(() => {
    void refresh();
    const timer = setInterval(refresh, POLL_INTERVAL_MS);
    return () => clearInterval(timer);
  }, [refresh]);

  const value = useMemo<DeviceContextValue>(
    () => ({ devices, serial, setSerial, status, refresh }),
    [devices, serial, status, refresh],
  );

  return <DeviceContext.Provider value={value}>{children}</DeviceContext.Provider>;
}

export function useDevice(): DeviceContextValue {
  const ctx = useContext(DeviceContext);
  if (!ctx) throw new Error("useDevice must be used within a DeviceProvider");
  return ctx;
}

/** Append the active device serial to a serve-emu API path (preserving any existing query). */
export function withDevice(path: string, serial: string | null): string {
  if (!serial) return path;
  const sep = path.includes("?") ? "&" : "?";
  return `${path}${sep}device=${encodeURIComponent(serial)}`;
}

export type Api = {
  serial: string | null;
  /** Build a device-scoped URL for WebSocket/EventSource. */
  url: (path: string) => string;
  /** `fetch`, with the active device serial appended to the path. */
  fetch: (path: string, init?: RequestInit) => Promise<Response>;
};

/** Device-scoped API helpers bound to the active serial. */
export function useApi(): Api {
  const { serial } = useDevice();
  return useMemo<Api>(
    () => ({
      serial,
      url: (path) => withDevice(path, serial),
      fetch: (path, init) => fetch(withDevice(path, serial), init),
    }),
    [serial],
  );
}
