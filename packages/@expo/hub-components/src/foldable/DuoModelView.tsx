/**
 * Mounts the iPhone Duo 3D scene over hidden panel streams, ported from
 * serve-sim's `src/client/components/duo-model-view.tsx` (@expo/serve-sim 0.5.0).
 */

import { SCREEN_LOAD_TIMEOUT_MS } from "@expo/hub-client";
import { useEffect, useRef, useState, type CSSProperties, type ReactNode } from "react";

import { createDuoScene, type DuoSceneState } from "./duo-scene";
import { DuoHingeHandle } from "./DuoHingeHandle";

/** Xcode's model: still loading, drawn, or unavailable (missing, broken, or too slow). */
export type DuoModelStatus = "loading" | "ready" | "unavailable";

export interface DuoModelViewProps extends DuoSceneState {
  /** The displays' elements. They stay mounted while their frames texture the model. */
  children: ReactNode;
  onStatusChange?: (status: DuoModelStatus) => void;
}

const STATUS_STYLE: CSSProperties = {
  position: "absolute",
  display: "flex",
  alignItems: "center",
  justifyContent: "center",
  padding: "6px 12px",
  borderRadius: 8,
  backgroundColor: "rgba(0, 0, 0, 0.55)",
  color: "rgba(255, 255, 255, 0.85)",
  fontSize: 12,
  fontFamily: "var(--expo-font-mono)",
  textAlign: "center",
  pointerEvents: "none",
};

/** The stream stays mounted while its decoded frames texture the articulated model. */
export function DuoModelView({ children, ...props }: DuoModelViewProps) {
  const host = useRef<HTMLDivElement>(null);
  const source = useRef<HTMLDivElement>(null);
  const hingeHandle = useRef<HTMLDivElement>(null);
  const oppositeHingeHandle = useRef<HTMLDivElement>(null);
  const latest = useRef<DuoSceneState>(props);
  latest.current = props;
  const [status, setStatus] = useState<DuoModelStatus>("loading");
  const onStatusChange = useRef(props.onStatusChange);
  onStatusChange.current = props.onStatusChange;
  useEffect(() => {
    onStatusChange.current?.(status);
  }, [status]);

  useEffect(() => {
    if (!host.current || !source.current) return;
    let settled = false;
    const unavailable = () => {
      if (settled) return;
      settled = true;
      setStatus("unavailable");
      latest.current.onUnavailable?.();
    };
    // @ref LLP 0015#errors — a model that never loads takes the 2D fallback instead of spinning
    const timeout = setTimeout(unavailable, SCREEN_LOAD_TIMEOUT_MS);
    const scene = createDuoScene(
      host.current,
      source.current,
      () => latest.current,
      {
        ready: () => {
          if (settled) return;
          settled = true;
          clearTimeout(timeout);
          setStatus("ready");
        },
        error: () => {
          clearTimeout(timeout);
          unavailable();
        },
      },
      { left: hingeHandle.current ?? undefined, right: oppositeHingeHandle.current ?? undefined },
    );
    return () => {
      settled = true;
      clearTimeout(timeout);
      scene.dispose();
    };
  }, []);

  const angle = props.angle ?? (props.streamConfig?.screenId === 1 ? 0 : 180);
  const onHingeAngleChange = status === "ready" ? props.onHingeAngleChange : undefined;

  return (
    <div style={{ position: "relative", width: "100%", height: "100%" }} data-duo-model={status}>
      <div
        ref={source}
        aria-hidden={status !== "unavailable"}
        style={
          status === "unavailable"
            ? { width: "100%", height: "100%" }
            : {
                position: "absolute",
                inset: 0,
                opacity: 0,
                pointerEvents: "none",
                overflow: "hidden",
              }
        }
      >
        {children}
      </div>
      <div
        ref={host}
        role="img"
        aria-label={`iPhone Duo 3D preview, ${props.pose ?? "custom"} pose${
          props.angle === undefined ? "" : `, ${Math.round(props.angle)} degrees`
        }`}
        style={{
          position: "absolute",
          inset: 0,
          overflow: "hidden",
          display: status === "unavailable" ? "none" : undefined,
          touchAction: "none",
        }}
      />
      <DuoHingeHandle
        handleRef={hingeHandle}
        side="left"
        angle={angle}
        onChange={onHingeAngleChange}
      />
      <DuoHingeHandle
        handleRef={oppositeHingeHandle}
        side="right"
        angle={angle}
        onChange={onHingeAngleChange}
      />
      {status === "unavailable" && (
        <span role="status" style={{ ...STATUS_STYLE, left: 16, right: 16, bottom: 8 }}>
          3D preview unavailable. Showing the live display.
        </span>
      )}
    </div>
  );
}
