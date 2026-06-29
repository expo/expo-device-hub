import { useEffect, useRef, useState } from "react";
import { useApi } from "../lib/device";

type LogLine = {
  id: number;
  line: string;
  at: string;
};

const MAX_LINES = 500;

export function LogcatPanel() {
  const nextIdRef = useRef(1);
  const pausedRef = useRef(false);
  const eventSourceRef = useRef<EventSource | null>(null);
  const [lines, setLines] = useState<LogLine[]>([]);
  const [packageName, setPackageName] = useState("");
  const [search, setSearch] = useState("");
  const [paused, setPaused] = useState(false);
  const [status, setStatus] = useState("Disconnected");
  const api = useApi();

  const connect = () => {
    eventSourceRef.current?.close();
    const params = new URLSearchParams();
    if (packageName.trim()) params.set("package", packageName.trim());
    if (search.trim()) params.set("search", search.trim());
    const source = new EventSource(api.url(`/api/logcat?${params}`));
    eventSourceRef.current = source;
    setStatus("Connecting");
    source.addEventListener("ready", () => setStatus("Streaming"));
    source.addEventListener("log", (event) => {
      if (pausedRef.current) return;
      try {
        const data = JSON.parse((event as MessageEvent).data) as { line: string; at: string };
        setLines((current) =>
          [...current, { id: nextIdRef.current++, line: data.line, at: data.at }].slice(-MAX_LINES),
        );
      } catch {}
    });
    source.addEventListener("error", () => setStatus("Error"));
  };

  useEffect(() => {
    // Reconnect when the active device changes (filters are applied manually).
    connect();
    return () => eventSourceRef.current?.close();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [api.serial]);

  useEffect(() => {
    pausedRef.current = paused;
  }, [paused]);

  const copyLogs = async () => {
    await navigator.clipboard.writeText(lines.map((line) => line.line).join("\n"));
    setStatus("Copied");
  };

  return (
    <section className="tool-panel logcat-panel">
      <div className="panel-heading">
        <h2>Logcat</h2>
        <div className="location-status">{status} • {lines.length}</div>
      </div>
      <div className="coordinate-grid">
        <label>
          Package
          <input
            onChange={(e) => setPackageName(e.currentTarget.value)}
            placeholder="com.example.app"
            value={packageName}
          />
        </label>
        <label>
          Search
          <input
            onChange={(e) => setSearch(e.currentTarget.value)}
            placeholder="error"
            value={search}
          />
        </label>
      </div>
      <div className="panel-actions">
        <button onClick={connect}>Apply</button>
        <button onClick={() => setPaused((v) => !v)}>{paused ? "Resume" : "Pause"}</button>
        <button onClick={() => setLines([])}>Clear</button>
        <button onClick={() => void copyLogs()}>Copy</button>
      </div>
      <pre className="logcat-output">
        {lines.length ? lines.map((entry) => entry.line).join("\n") : "Waiting for logcat..."}
      </pre>
    </section>
  );
}
