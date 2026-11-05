/**
 * Mounts a device model's 3D scene over its hidden display streams, ported from
 * serve-sim's `src/client/components/duo-model-view.tsx` (serve-sim at 3dc61286e, #383),
 * where it showed the iPhone Duo.
 */

import { SCREEN_LOAD_TIMEOUT_MS, useVisibleTimeout } from "@expo/hub-client";
import {
  useCallback,
  useEffect,
  useRef,
  useState,
  type CSSProperties,
  type ReactNode,
} from "react";

import { bg, border, radius, text, textSize } from "../theme/tokens";
import { createDuoScene, type DuoSceneState } from "./duo-scene";
import { DuoHingeHandle } from "./DuoHingeHandle";

/** The model: still loading, loaded into the scene, or unavailable (missing, broken, or too slow). */
export type DuoModelStatus = "loading" | "ready" | "unavailable";

export interface DuoModelViewProps extends DuoSceneState {
  /** The displays' elements. They stay mounted while their frames texture the model. */
  children: ReactNode;
  onStatusChange?: (status: DuoModelStatus) => void;
}

const NOTICE_STYLE: CSSProperties = {
  ...textSize.xs,
  position: "absolute",
  left: 16,
  right: 16,
  bottom: 8,
  padding: "6px 12px",
  borderRadius: radius.md,
  border: `1px solid ${border.default}`,
  backgroundColor: bg.default,
  color: text.secondary,
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

  // A timeout before the scene is ready wins, and a scene error at any time
  // falls back to the flat displays for good.
  const statusRef = useRef<DuoModelStatus>("loading");
  const ready = useCallback(() => {
    if (statusRef.current !== "loading") return;
    statusRef.current = "ready";
    setStatus("ready");
  }, []);
  const unavailable = useCallback(() => {
    if (statusRef.current === "unavailable") return;
    statusRef.current = "unavailable";
    setStatus("unavailable");
    latest.current.onUnavailable?.();
  }, []);
  // @ref LLP 0015#errors — a model that does not load in time takes the 2D fallback instead of spinning
  useVisibleTimeout(status === "loading", SCREEN_LOAD_TIMEOUT_MS, unavailable);

  // Stops the running scene once; the flat fallback needs no 3D rendering.
  const stopScene = useRef<() => void>(() => {});
  useEffect(() => {
    if (!host.current || !source.current) return;
    let disposed = false;
    const scene = createDuoScene(
      host.current,
      source.current,
      () => latest.current,
      {
        ready: () => {
          if (!disposed) ready();
        },
        error: () => {
          if (!disposed) unavailable();
        },
      },
      { left: hingeHandle.current ?? undefined, right: oppositeHingeHandle.current ?? undefined },
    );
    const stop = () => {
      if (disposed) return;
      disposed = true;
      scene.dispose();
    };
    stopScene.current = stop;
    return stop;
  }, [ready, unavailable]);
  // A timeout or an error falls back for good, so the hidden scene stops
  // drawing the stream and rendering at the display's frame rate.
  useEffect(() => {
    if (status === "unavailable") stopScene.current();
  }, [status]);

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
        aria-label={
          props.model.hinge
            ? `${props.model.name} 3D preview, ${props.pose ?? "custom"} pose${
                props.angle === undefined ? "" : `, ${Math.round(props.angle)} degrees`
              }`
            : `${props.model.name} 3D preview`
        }
        style={{
          position: "absolute",
          inset: 0,
          overflow: "hidden",
          display: status === "unavailable" ? "none" : undefined,
          touchAction: "none",
        }}
      />
      {props.model.hinge && (
        <>
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
        </>
      )}
      {status === "unavailable" && (
        <span role="status" style={NOTICE_STYLE}>
          3D preview unavailable. Showing the live display.
        </span>
      )}
    </div>
  );
}
