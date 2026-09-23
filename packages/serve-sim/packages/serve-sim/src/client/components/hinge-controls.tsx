import { HINGE_POSES, type HingeControlCommand, type HingePose } from "../../hinge-control";
import { SimulatorToolbar } from "../simulator";
import closedIcon from "../assets/hinge-closed.svg" with { type: "text" };
import bookIcon from "../assets/hinge-half-open.svg" with { type: "text" };
import openIcon from "../assets/hinge-open.svg" with { type: "text" };

export const FOLD_POSE_OPTIONS: Array<{ value: HingePose; label: string }> = [
  { value: "closed", label: "Fully folded" },
  { value: "book", label: "Partially open" },
  { value: "open", label: "Fully open" },
  { value: "laptop", label: "Laptop" },
  { value: "tent", label: "Tent" },
];

const hingeIcons = new Map<HingePose, string>(
  ([["closed", closedIcon], ["book", bookIcon], ["open", openIcon]] as const)
    .map(([pose, svg]) => [pose, `url("data:image/svg+xml,${encodeURIComponent(svg)}")`]),
);

export interface HingeControlsProps {
  angle?: number;
  pose?: HingePose | null;
  supported?: boolean;
  tableMode?: boolean;
  tableModeAvailable?: boolean;
  viewMode?: "2d" | "3d";
  onViewModeChange?: (mode: "2d" | "3d") => void;
  viewError?: string | null;
  cacheScreenOnFold?: boolean;
  onCacheScreenOnFoldChange?: (enabled: boolean) => void;
  sizeMode?: "physical" | "fill";
  onSizeModeChange?: (mode: "physical" | "fill") => void;
  pending?: boolean;
  error?: string | null;
  onChange: (command: HingeControlCommand) => void;
}

/** The three everyday fold positions; detailed controls live in the sidebar. */
export function HingeControls({ angle, pose, supported, pending = false, error, onChange }: HingeControlsProps) {
  if (!(supported ?? angle !== undefined)) return null;
  const selectedPose = pose !== undefined ? pose : angle === 0 ? "closed" : angle === 180 ? "open" : null;

  return (
    <div
      role="group"
      aria-label="Fold position"
      aria-busy={pending}
      style={{
        position: "relative", display: "inline-flex", flexShrink: 0, gap: 4,
        padding: "6px 8px", borderRadius: 18,
        background: "var(--serve-sim-panel-bg, #181818)",
        border: "1px solid rgba(255,255,255,0.1)",
      }}
    >
      {FOLD_POSE_OPTIONS.slice(0, 3).map((position) => {
        const selected = selectedPose === position.value;
        const shortcut = HINGE_POSES.findIndex((pose) => pose.id === position.value) + 1;
        return (
          <SimulatorToolbar.Button
            key={position.value}
            aria-label={position.label}
            title={`${position.label} (⌥⇧${shortcut})`}
            aria-pressed={selected}
            onClick={() => onChange({ control: "pose", value: position.value })}
            style={{ background: selected ? "#3b3b3b" : undefined, color: selected ? "#fff" : "#c6c6c6", opacity: 1 }}
          >
            <span
              aria-hidden="true"
              style={{
                display: "block", width: 20, height: 20,
                backgroundColor: "currentColor", maskImage: hingeIcons.get(position.value),
                maskSize: "contain", maskRepeat: "no-repeat", maskPosition: "center",
              }}
            />
          </SimulatorToolbar.Button>
        );
      })}
      {error && (
        <span role="alert" style={{ position: "absolute", top: "calc(100% + 6px)", left: 0, width: "min(280px, calc(100vw - 32px))", color: "#fca5a5", fontSize: 12 }}>
          {error}
        </span>
      )}
    </div>
  );
}
