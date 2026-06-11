import { useCallback, useEffect, useRef, useState } from "react";
import { StatusBar } from "./components/status-bar";
import { AppManagementPanel } from "./components/app-management-panel";
import { AccessibilityPanel, type AccessibilityNode } from "./components/accessibility-panel";
import { DevicePanel } from "./components/device-panel";
import { DeviceStream } from "./components/device-stream";
import { ControlBar, type HardwareKey } from "./components/control-bar";
import { LogcatPanel } from "./components/logcat-panel";
import { LocationPanel } from "./components/location-panel";
import { SessionPanel } from "./components/session-panel";
import { useStream } from "./lib/use-stream";

export function App() {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const { state, send } = useStream(canvasRef);
  const [accessibilityEnabled, setAccessibilityEnabled] = useState(false);
  const [accessibilityNodes, setAccessibilityNodes] = useState<AccessibilityNode[]>([]);
  const [highlightedAccessibilityId, setHighlightedAccessibilityId] = useState<string | null>(null);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.target !== document.body) return;
      if (e.key === "Escape") {
        send({ type: "back" });
        return;
      }
      if (e.key === "Enter") {
        send({ type: "key", keycode: 66 });
        return;
      }
      if (e.key.length === 1) {
        send({ type: "text", text: e.key });
      }
    };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [send]);

  const onPress = useCallback(
    (key: HardwareKey) => send({ type: key }),
    [send],
  );

  return (
    <>
      <StatusBar status={state.status} deviceSize={state.deviceSize} fps={state.fps} />
      <main>
        <div className="device">
          <DeviceStream
            canvasRef={canvasRef}
            send={send}
            accessibilityEnabled={accessibilityEnabled}
            accessibilityNodes={accessibilityNodes}
            highlightedAccessibilityId={highlightedAccessibilityId}
            deviceSize={state.deviceSize}
          />
        </div>
        <aside className="side-panel">
          <DevicePanel />
          <AccessibilityPanel
            enabled={accessibilityEnabled}
            nodes={accessibilityNodes}
            highlightedId={highlightedAccessibilityId}
            onEnabledChange={setAccessibilityEnabled}
            onNodesChange={setAccessibilityNodes}
            onHighlight={setHighlightedAccessibilityId}
          />
          <LocationPanel />
          <AppManagementPanel />
          <LogcatPanel />
          <SessionPanel />
        </aside>
      </main>
      <ControlBar onPress={onPress} />
    </>
  );
}
