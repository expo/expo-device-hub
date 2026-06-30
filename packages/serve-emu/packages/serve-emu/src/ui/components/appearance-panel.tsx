import { useCallback, useEffect, useState } from "react";
import { useApi } from "../lib/device";

type NightMode = "yes" | "no" | "auto";

const OPTIONS: { label: string; mode: NightMode }[] = [
  { label: "Light", mode: "no" },
  { label: "Dark", mode: "yes" },
  { label: "Auto", mode: "auto" },
];

type UiModeResponse = { ok?: boolean; night?: string; error?: string };

/**
 * Reads and toggles the device's system dark theme via `/api/uimode`
 * (`adb shell cmd uimode night yes|no|auto`). Fetches the current mode on mount
 * and whenever the active device changes.
 */
export function AppearancePanel() {
  const api = useApi();
  const [mode, setMode] = useState<string | null>(null);
  const [status, setStatus] = useState("Loading…");
  const [busy, setBusy] = useState(false);

  const load = useCallback(async () => {
    setStatus("Loading…");
    try {
      const res = await api.fetch("/api/uimode", { cache: "no-store" });
      const data = (await res.json()) as UiModeResponse;
      if (!res.ok || !data.ok) throw new Error(data.error || `HTTP ${res.status}`);
      setMode(data.night ?? null);
      setStatus("Ready");
    } catch (err) {
      setMode(null);
      setStatus(err instanceof Error ? err.message : String(err));
    }
  }, [api]);

  // Re-reads on device switch: `api` is memoized on the active serial.
  useEffect(() => {
    void load();
  }, [load]);

  const apply = useCallback(
    async (next: NightMode) => {
      setBusy(true);
      setStatus("Applying…");
      try {
        const res = await api.fetch("/api/uimode", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ night: next }),
        });
        const data = (await res.json()) as UiModeResponse;
        if (!res.ok || !data.ok) throw new Error(data.error || `HTTP ${res.status}`);
        setMode(data.night ?? next);
        setStatus("Ready");
      } catch (err) {
        setStatus(err instanceof Error ? err.message : String(err));
      } finally {
        setBusy(false);
      }
    },
    [api],
  );

  return (
    <section className="tool-panel appearance-panel">
      <div className="panel-heading">
        <h2>Appearance</h2>
        <div className="location-status">{status}</div>
      </div>
      <div className="appearance-options">
        {OPTIONS.map((opt) => {
          const active = mode === opt.mode;
          return (
            <button
              key={opt.mode}
              type="button"
              className={active ? "appearance-option current" : "appearance-option"}
              aria-pressed={active}
              disabled={busy}
              onClick={() => void apply(opt.mode)}
            >
              {opt.label}
            </button>
          );
        })}
      </div>
    </section>
  );
}
