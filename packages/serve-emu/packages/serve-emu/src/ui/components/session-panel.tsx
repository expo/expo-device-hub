import { useEffect, useState } from "react";

type SessionEvent = {
  id: number;
  at: string;
  delayMs: number;
  source: string;
  kind: "gesture" | "location";
  gesture?: { type: string };
  location?: { latitude: number; longitude: number };
};

type SessionSnapshot = {
  events: SessionEvent[];
  recording: boolean;
  replaying: boolean;
  lastError: string | null;
};

function labelForEvent(event: SessionEvent): string {
  if (event.kind === "gesture") return `${event.gesture?.type ?? "gesture"} • ${event.source}`;
  const lat = event.location?.latitude.toFixed(5) ?? "?";
  const lng = event.location?.longitude.toFixed(5) ?? "?";
  return `location ${lat}, ${lng}`;
}

export function SessionPanel() {
  const [session, setSession] = useState<SessionSnapshot | null>(null);
  const [multiplier, setMultiplier] = useState("1");
  const [status, setStatus] = useState("Ready");

  const refresh = () => {
    fetch("/api/session")
      .then((r) => r.json() as Promise<SessionSnapshot>)
      .then(setSession)
      .catch(() => setStatus("Session unavailable"));
  };

  useEffect(() => {
    refresh();
    const timer = setInterval(refresh, 1000);
    return () => clearInterval(timer);
  }, []);

  const replay = async () => {
    const rate = Number(multiplier);
    if (!Number.isFinite(rate) || rate <= 0) {
      setStatus("Rate must be positive");
      return;
    }
    const res = await fetch("/api/session/replay", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ multiplier: rate }),
    });
    const data = await res.json() as { ok?: boolean; error?: string; session?: SessionSnapshot };
    if (!res.ok || !data.ok) {
      setStatus(data.error ?? "Replay failed");
      return;
    }
    setSession(data.session ?? null);
    setStatus("Replaying");
  };

  const stopReplay = async () => {
    const res = await fetch("/api/session/replay/stop", { method: "POST" });
    const data = await res.json() as { session?: SessionSnapshot };
    setSession(data.session ?? null);
    setStatus("Replay stopped");
  };

  const clear = async () => {
    const res = await fetch("/api/session", { method: "DELETE" });
    const data = await res.json() as { session?: SessionSnapshot };
    setSession(data.session ?? null);
    setStatus("Cleared");
  };

  const copy = async () => {
    await navigator.clipboard.writeText(JSON.stringify(session?.events ?? [], null, 2));
    setStatus("Copied");
  };

  const recent = session?.events.slice(-6).reverse() ?? [];

  return (
    <section className="tool-panel session-panel">
      <div className="panel-heading">
        <h2>Session</h2>
        <div className="location-status">
          {session?.replaying ? "Replaying" : status} • {session?.events.length ?? 0}
        </div>
      </div>
      <div className="coordinate-grid">
        <label>
          Rate
          <input
            inputMode="decimal"
            onChange={(e) => setMultiplier(e.currentTarget.value)}
            value={multiplier}
          />
        </label>
        <label>
          Mode
          <input readOnly value={session?.recording ? "Recording" : "Paused"} />
        </label>
      </div>
      <div className="panel-actions">
        <button onClick={() => void replay()}>Replay</button>
        <button onClick={() => void stopReplay()}>Stop</button>
        <button onClick={() => void clear()}>Clear</button>
        <button onClick={() => void copy()}>Copy</button>
      </div>
      <div className="session-list">
        {recent.length
          ? recent.map((event) => (
              <div key={event.id}>
                <span>+{Math.round(event.delayMs)}ms</span>
                {labelForEvent(event)}
              </div>
            ))
          : <div>No recorded events</div>}
      </div>
      {session?.lastError && <div className="route-meta">{session.lastError}</div>}
    </section>
  );
}
