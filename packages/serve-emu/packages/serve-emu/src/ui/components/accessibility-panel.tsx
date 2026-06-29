import { useCallback, useEffect, useState } from "react";
import { useApi } from "../lib/device";

export type AccessibilityNode = {
  id: string;
  text: string;
  contentDescription: string;
  resourceId: string;
  className: string;
  packageName: string;
  clickable: boolean;
  enabled: boolean;
  bounds: { left: number; top: number; right: number; bottom: number };
};

type Props = {
  enabled: boolean;
  nodes: AccessibilityNode[];
  highlightedId: string | null;
  onEnabledChange: (enabled: boolean) => void;
  onNodesChange: (nodes: AccessibilityNode[]) => void;
  onHighlight: (id: string | null) => void;
};

function nodeLabel(node: AccessibilityNode): string {
  return node.text || node.contentDescription || node.resourceId || node.className || "Unlabeled";
}

function nodeMeta(node: AccessibilityNode): string {
  const role = node.className.split(".").pop() || "node";
  const width = node.bounds.right - node.bounds.left;
  const height = node.bounds.bottom - node.bounds.top;
  return `${role} · ${width}x${height}`;
}

export function AccessibilityPanel({
  enabled,
  nodes,
  highlightedId,
  onEnabledChange,
  onNodesChange,
  onHighlight,
}: Props) {
  const [status, setStatus] = useState("AX off");
  const api = useApi();

  const refresh = useCallback(async () => {
    if (!enabled) return;
    setStatus("Reading...");
    try {
      const res = await api.fetch("/api/accessibility", { cache: "no-store" });
      const json = await res.json() as { ok?: boolean; nodes?: AccessibilityNode[]; error?: string };
      if (!json.ok || !json.nodes) {
        setStatus(json.error || "AX unavailable");
        onNodesChange([]);
        return;
      }
      onNodesChange(json.nodes);
      setStatus(`${json.nodes.length} nodes`);
    } catch (err) {
      onNodesChange([]);
      setStatus(err instanceof Error ? err.message : String(err));
    }
  }, [enabled, onNodesChange, api]);

  useEffect(() => {
    if (!enabled) {
      onNodesChange([]);
      onHighlight(null);
      setStatus("AX off");
      return;
    }
    void refresh();
    const timer = setInterval(refresh, 3000);
    return () => clearInterval(timer);
  }, [enabled, refresh, onHighlight, onNodesChange]);

  return (
    <section className="tool-panel accessibility-panel">
      <div className="panel-heading">
        <h2>Accessibility</h2>
        <div className="location-status">{status}</div>
      </div>
      <div className="panel-actions ax-actions">
        <button onClick={() => onEnabledChange(!enabled)}>{enabled ? "Hide" : "Show"}</button>
        <button onClick={() => void refresh()} disabled={!enabled}>
          Refresh
        </button>
      </div>
      {enabled && (
        <div className="ax-list" role="list">
          {nodes.length === 0 ? (
            <div className="ax-empty">No accessibility nodes yet.</div>
          ) : (
            nodes.map((node) => (
              <button
                key={node.id}
                type="button"
                className={node.id === highlightedId ? "ax-node active" : "ax-node"}
                onMouseEnter={() => onHighlight(node.id)}
                onMouseLeave={() => onHighlight(null)}
                onFocus={() => onHighlight(node.id)}
                onBlur={() => onHighlight(null)}
                title={node.resourceId || node.packageName}
              >
                <span>{nodeLabel(node)}</span>
                <code>{nodeMeta(node)}</code>
              </button>
            ))
          )}
        </div>
      )}
    </section>
  );
}
