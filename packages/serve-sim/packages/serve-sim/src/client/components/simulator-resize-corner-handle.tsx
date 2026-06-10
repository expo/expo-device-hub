// Curved-arc resize affordance anchored to the bottom-right of the simulator
// frame. The SVG owns the pointer surface (with a generous transparent hit
// stroke), and the wrapper div carries the role="separator"/aria for the
// keyboard surface. Visuals: per-phase scale/stroke and a focus ring that
// follows the arc path.

import {
  forwardRef,
  useMemo,
  useState,
  type CSSProperties,
  type MouseEventHandler as ReactMouseEventHandler,
  type PointerEventHandler as ReactPointerEventHandler,
  type Ref,
} from "react";
import {
  simulatorResizeCornerArc,
  type DeviceType,
  type StreamConfig,
} from "serve-sim-client/simulator";
import { useSimulatorResize } from "../hooks/use-simulator-resize";
import { usePrefersMoreContrast } from "../hooks/use-prefers-more-contrast";
import { usePrefersReducedMotion } from "../hooks/use-prefers-reduced-motion";
import {
  RESIZE_MAIN_STROKE,
  RESIZE_MAIN_STROKE_W,
  RESIZE_SCALE,
  SIMULATOR_RESIZE_EASE,
  SIMULATOR_RESIZE_EASE_OUT,
  SIMULATOR_RESIZE_HANDLE_DUR_HOT,
  SIMULATOR_RESIZE_HANDLE_DUR_IDLE,
  SIMULATOR_RESIZE_HIT_SLOP,
  SIMULATOR_RESIZE_SPRING,
  supportsLinearEasing,
  type ResizeVisualPhase,
  type SimulatorResizeArc,
} from "../utils/simulator-resize";

const RESIZE_HANDLE_LIT_SHADOW =
  "drop-shadow(0 0.5px 1px rgba(0,0,0,0.1)) drop-shadow(0 2px 5px rgba(0,0,0,0.13))";

type SimulatorResizeCornerSvgProps = {
  arc: SimulatorResizeArc;
  phase: ResizeVisualPhase;
  reducedMotion: boolean;
  highContrast: boolean;
  focusVisible: boolean;
  onPointerDown: ReactPointerEventHandler<SVGSVGElement>;
  onPointerMove: ReactPointerEventHandler<SVGSVGElement>;
  onPointerUp: ReactPointerEventHandler<SVGSVGElement>;
  onPointerCancel: ReactPointerEventHandler<SVGSVGElement>;
  onPointerEnter: ReactPointerEventHandler<SVGSVGElement>;
  onPointerLeave: ReactPointerEventHandler<SVGSVGElement>;
  onMouseDown?: ReactMouseEventHandler<SVGSVGElement>;
};

const SimulatorResizeCornerSvg = forwardRef(function SimulatorResizeCornerSvg(
  {
    arc,
    phase,
    reducedMotion,
    highContrast,
    focusVisible,
    onPointerDown,
    onPointerMove,
    onPointerUp,
    onPointerCancel,
    onPointerEnter,
    onPointerLeave,
    onMouseDown,
  }: SimulatorResizeCornerSvgProps,
  ref: Ref<SVGSVGElement | null>,
) {
  const isHot = phase !== "idle";

  const vw = highContrast ? 1.12 : 1;
  const hitStrokeW = (6 + SIMULATOR_RESIZE_HIT_SLOP * 2) * vw;
  const scale = reducedMotion ? 1 : RESIZE_SCALE[phase];
  const mainStrokeW = RESIZE_MAIN_STROKE_W[phase] * vw;

  const dur = isHot ? SIMULATOR_RESIZE_HANDLE_DUR_HOT : SIMULATOR_RESIZE_HANDLE_DUR_IDLE;
  const ease = isHot ? SIMULATOR_RESIZE_EASE : SIMULATOR_RESIZE_EASE_OUT;
  // Spring overshoot on the way in; flat ease-out on the way out.
  // Spring is only used when the engine supports `linear()`.
  const scaleEase = isHot && supportsLinearEasing() ? SIMULATOR_RESIZE_SPRING : ease;
  const motionTransform = reducedMotion ? "none" : `transform ${dur} ${scaleEase}`;
  const motionStroke = reducedMotion ? "none" : `stroke ${dur} ${ease}, stroke-width ${dur} ${ease}`;

  const vb = arc.viewBoxSize;
  const d = arc.d;

  const scaleGroupStyle: CSSProperties = {
    transform: `translate3d(0,0,0) scale(${scale})`,
    transformOrigin: "100% 100%",
    transition: motionTransform,
    willChange: reducedMotion ? undefined : "transform",
    backfaceVisibility: "hidden",
    WebkitBackfaceVisibility: "hidden",
  };

  return (
    <svg
      ref={ref}
      width={vb}
      height={vb}
      viewBox={`0 0 ${vb} ${vb}`}
      fill="none"
      xmlns="http://www.w3.org/2000/svg"
      aria-hidden="true"
      shapeRendering="geometricPrecision"
      style={{
        display: "block",
        overflow: "visible",
        cursor: "nwse-resize",
        touchAction: "none",
        pointerEvents: "auto",
      }}
      onPointerDown={onPointerDown}
      onPointerMove={onPointerMove}
      onPointerUp={onPointerUp}
      onPointerCancel={onPointerCancel}
      onLostPointerCapture={onPointerUp}
      onPointerEnter={onPointerEnter}
      onPointerLeave={onPointerLeave}
      onMouseDown={onMouseDown}
    >
      <g aria-hidden="true" style={{ pointerEvents: "none" }}>
        <path
          d={d}
          fill="none"
          stroke="rgba(10, 132, 255, 0.95)"
          strokeWidth={(SIMULATOR_RESIZE_HIT_SLOP * 2 + 6) * vw}
          strokeLinecap="round"
          vectorEffect="non-scaling-stroke"
          style={{
            opacity: focusVisible ? 0.95 : 0,
            transition: reducedMotion
              ? "opacity 80ms linear"
              : `opacity 200ms ${SIMULATOR_RESIZE_EASE_OUT}`,
            filter:
              "drop-shadow(0 0 2px rgba(10,132,255,0.55)) drop-shadow(0 0 4px rgba(10,132,255,0.32))",
          }}
        />
        <path
          d={d}
          fill="none"
          stroke="rgba(255,255,255,0.95)"
          strokeWidth={1.5 * vw}
          strokeLinecap="round"
          vectorEffect="non-scaling-stroke"
          style={{
            opacity: focusVisible ? 0.7 : 0,
            transition: reducedMotion
              ? "opacity 80ms linear"
              : `opacity 200ms ${SIMULATOR_RESIZE_EASE_OUT}`,
          }}
        />
      </g>

      <g aria-hidden="true" style={scaleGroupStyle}>
        <g style={{ pointerEvents: "none" }}>
          <path
            d={d}
            stroke="#34363b"
            strokeWidth={mainStrokeW + 2.2 * vw}
            strokeLinecap="round"
            vectorEffect="non-scaling-stroke"
            style={{ transition: motionStroke, filter: RESIZE_HANDLE_LIT_SHADOW }}
          />
          <path
            d={d}
            stroke={RESIZE_MAIN_STROKE[phase]}
            strokeWidth={mainStrokeW}
            strokeLinecap="round"
            vectorEffect="non-scaling-stroke"
            style={{ transition: motionStroke, filter: RESIZE_HANDLE_LIT_SHADOW }}
          />
        </g>
        <path
          d={d}
          fill="none"
          stroke="rgba(0,0,0,0)"
          strokeWidth={hitStrokeW}
          strokeLinecap="round"
          pointerEvents="stroke"
        />
      </g>
    </svg>
  );
});

type SimulatorResize = ReturnType<typeof useSimulatorResize>;

export function SimulatorResizeCornerHandle({
  simulatorResize,
  deviceType,
  streamConfig,
  containerWidth,
  containerHeight,
}: {
  simulatorResize: SimulatorResize;
  deviceType: DeviceType;
  streamConfig:
    | Pick<StreamConfig, "width" | "height" | "orientation">
    | null
    | undefined;
  containerWidth: number;
  containerHeight: number;
}) {
  const reducedMotion = usePrefersReducedMotion();
  const highContrast = usePrefersMoreContrast();
  const [focusVisible, setFocusVisible] = useState(false);

  const arc = useMemo(
    () =>
      simulatorResizeCornerArc({
        type: deviceType,
        config: streamConfig ?? null,
        containerWidth,
        containerHeight,
      }),
    [deviceType, streamConfig, containerWidth, containerHeight],
  );

  const phase: ResizeVisualPhase =
    simulatorResize.isResizing || simulatorResize.isInertia
      ? "drag"
      : simulatorResize.handleHovered
        ? "hover"
        : "idle";

  return (
    <div
      role="separator"
      aria-label="Resize simulator width. Drag the corner or use Left and Right Arrow keys; hold Shift for larger steps."
      aria-orientation="vertical"
      aria-valuemin={Math.round(simulatorResize.minWidth)}
      aria-valuemax={Math.round(simulatorResize.maxWidth)}
      aria-valuenow={Math.round(simulatorResize.committedWidth)}
      tabIndex={0}
      onKeyDown={simulatorResize.onKeyDown}
      onFocus={(e) => {
        setFocusVisible(e.currentTarget.matches?.(":focus-visible") ?? false);
      }}
      onBlur={() => setFocusVisible(false)}
      style={{
        position: "absolute",
        right: -14,
        bottom: -14,
        width: 60,
        height: 60,
        border: "none",
        padding: 0,
        margin: 0,
        display: "flex",
        alignItems: "flex-end",
        justifyContent: "flex-end",
        background: "transparent",
        pointerEvents: "none",
        outline: "none",
        zIndex: 25,
        WebkitTapHighlightColor: "transparent",
      }}
    >
      <SimulatorResizeCornerSvg
        ref={simulatorResize.handleRef}
        arc={arc}
        phase={phase}
        reducedMotion={reducedMotion}
        highContrast={highContrast}
        focusVisible={focusVisible}
        onPointerDown={simulatorResize.onPointerDown}
        onPointerMove={simulatorResize.onPointerMove}
        onPointerUp={simulatorResize.onPointerEnd}
        onPointerCancel={simulatorResize.onPointerEnd}
        onPointerEnter={() => simulatorResize.setHandleHovered(true)}
        onPointerLeave={() => simulatorResize.setHandleHovered(false)}
      />
    </div>
  );
}
