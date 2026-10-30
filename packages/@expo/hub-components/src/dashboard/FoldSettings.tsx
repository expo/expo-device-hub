import { useEffect, useId, useState } from "react";

import { type DeviceFold, type DeviceFoldCapabilities } from "@expo/hub-client";
import { Select, type SelectOption, bg, border, radius, text, textSize } from "../primitives";
import { DisabledControlHint } from "../components/DisabledControlHint";
import { FOLD_POSE_OPTIONS, selectedFoldPose } from "./foldPoses";
import { type FoldPreviewMode } from "./PhoneFrame";
import { SidebarRow, SidebarSlider, SidebarSwitch } from "./SidebarRow";

/**
 * Viewer-local choices for how the iPhone Duo is drawn; owned by the consumer.
 * Pass them only for a client that can feed the 3D model.
 */
export type FoldPreviewOption = {
  mode: FoldPreviewMode;
  onModeChange: (mode: FoldPreviewMode) => void;
  /** The model failed to load in this session; the flat screen shows until 3D is selected again. */
  unavailable?: boolean;
  /** Freeze the departing panel's last frame while the device folds. */
  cacheScreenOnFold: boolean;
  onCacheScreenOnFoldChange: (enabled: boolean) => void;
  /** Keep the model at its physical size, or fill the stage as the hinge moves. */
  sizeMode: "physical" | "fill";
  onSizeModeChange: (mode: "physical" | "fill") => void;
};

export const MODEL_UNAVAILABLE_DESCRIPTION = "3D preview unavailable. Select 3D to retry.";

const PREVIEW_MODE_OPTIONS: ReadonlyArray<SelectOption<FoldPreviewMode>> = [
  { value: "3d", label: "3D" },
  { value: "2d", label: "2D" },
];

const PREVIEW_SIZE_OPTIONS: ReadonlyArray<SelectOption<"physical" | "fill">> = [
  { value: "physical", label: "Keep same size" },
  { value: "fill", label: "Fill available space" },
];

const SLIDER_WIDTH = 112;

/**
 * A foldable's controls, placed at the top of Device options like serve-sim's
 * Simulator settings: the named poses, a live hinge slider with a decimal
 * degree input, Table Mode, and the viewer's 2D/3D preview choices. Each row
 * shows only what the device offers (the iPhone Duo offers all of them). Every
 * change waits for the device's acknowledgement while the controls stay
 * enabled, so a slider drag feels live.
 */
export function FoldSettings({
  fold,
  controls,
  preview,
}: {
  fold: DeviceFold;
  /** `client.capabilities.fold`: the rows to show. */
  controls: Exclude<DeviceFoldCapabilities, false>;
  preview?: FoldPreviewOption;
}) {
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState("");
  const [angleDraft, setAngleDraft] = useState<number | null>(null);
  const [adjusting, setAdjusting] = useState(false);
  const previewDescriptionId = useId();
  const { angle, pose, pending, error } = fold;
  const tableMode = controls.tableMode ? fold.tableMode : undefined;
  const angleRange = controls.angle;

  useEffect(() => {
    if (error || (!pending && !adjusting)) setAngleDraft(null);
  }, [pending, adjusting, error]);
  useEffect(() => {
    if (error) {
      setEditing(false);
      setAdjusting(false);
    }
  }, [error]);

  const displayedAngle = angleDraft ?? angle;
  const offeredPoses = FOLD_POSE_OPTIONS.filter((option) => controls.poses[option.value]);
  const selectedPose = angleDraft !== null ? null : selectedFoldPose(angle, pose, controls.poses);
  const poseValue = selectedPose ?? (displayedAngle === undefined ? "unknown" : "custom");
  const poseOptions: ReadonlyArray<SelectOption> =
    selectedPose === null || !controls.poses[selectedPose]
      ? [
          ...offeredPoses,
          {
            value: poseValue,
            label: poseValue === "unknown" ? "Unknown" : "Custom",
            disabled: true,
          },
        ]
      : offeredPoses;
  const canChangeTableMode = (tableMode?.available ?? false) || tableMode?.enabled === true;
  // An unavailable model shows the flat screen until 3D is selected again.
  const viewMode: FoldPreviewMode = preview?.mode === "3d" && !preview.unavailable ? "3d" : "2d";
  const changeAngle = (value: number) => {
    setAngleDraft(value);
    fold.setControl({ control: "angle", value });
  };
  const selectPose = (value: string) => {
    const position = offeredPoses.find((option) => option.value === value);
    if (!position) return;
    setAngleDraft(null);
    setAdjusting(false);
    setEditing(false);
    fold.setControl({ control: "pose", value: position.value });
  };

  return (
    <div role="group" aria-label="Fold settings" aria-busy={pending || undefined}>
      {offeredPoses.length > 0 && (
        <SidebarRow label="Fold pose">
          <Select
            ariaLabel="Fold pose"
            options={poseOptions}
            value={poseValue}
            onChange={selectPose}
            onReselect={selectPose}
          />
        </SidebarRow>
      )}
      {angleRange && (
        <SidebarRow label="Hinge angle">
          <span style={{ display: "flex", minWidth: 0, alignItems: "center", gap: 8 }}>
            <SidebarSlider
              label="Hinge angle"
              valueText={displayedAngle === undefined ? "Unknown" : `${displayedAngle} degrees`}
              min={angleRange.min}
              max={angleRange.max}
              value={displayedAngle ?? (angleRange.min + angleRange.max) / 2}
              width={SLIDER_WIDTH}
              onChange={changeAngle}
              onAdjustStart={() => setAdjusting(true)}
              onAdjustEnd={() => setAdjusting(false)}
            />
            <input
              type="number"
              aria-label="Hinge angle in degrees"
              min={angleRange.min}
              max={angleRange.max}
              step="any"
              placeholder="—"
              value={editing ? draft : (displayedAngle ?? "")}
              onFocus={() => {
                setDraft(displayedAngle === undefined ? "" : String(displayedAngle));
                setEditing(true);
              }}
              onChange={(event) => {
                const { value, valueAsNumber } = event.currentTarget;
                setDraft(value);
                if (
                  Number.isFinite(valueAsNumber) &&
                  valueAsNumber >= angleRange.min &&
                  valueAsNumber <= angleRange.max
                ) {
                  changeAngle(valueAsNumber);
                }
              }}
              onBlur={() => setEditing(false)}
              onKeyDown={(event) => {
                if (event.key === "Enter") event.currentTarget.blur();
              }}
              style={{
                ...textSize.sm,
                width: 56,
                boxSizing: "border-box",
                padding: "4px 6px",
                border: `1px solid ${border.default}`,
                borderRadius: radius.md,
                backgroundColor: bg.default,
                color: text.default,
                fontFamily: "inherit",
                textAlign: "right",
              }}
            />
          </span>
        </SidebarRow>
      )}
      {tableMode && (
        <SidebarRow label="Table Mode">
          <DisabledControlHint
            reason={
              !canChangeTableMode ? "Table Mode is not available in the current pose." : undefined
            }
            label="Table Mode"
          >
            <SidebarSwitch
              label="Table Mode"
              checked={tableMode.enabled ?? false}
              disabled={!canChangeTableMode}
              onChange={(value) => fold.setControl({ control: "tableMode", value })}
            />
          </DisabledControlHint>
        </SidebarRow>
      )}
      {preview && (
        <>
          <SidebarRow
            label="Preview mode"
            description={preview.unavailable ? MODEL_UNAVAILABLE_DESCRIPTION : undefined}
            descriptionId={preview.unavailable ? previewDescriptionId : undefined}
          >
            <Select
              ariaLabel="Preview mode"
              ariaDescribedBy={preview.unavailable ? previewDescriptionId : undefined}
              options={PREVIEW_MODE_OPTIONS}
              value={viewMode}
              onChange={preview.onModeChange}
            />
          </SidebarRow>
          {viewMode === "3d" && (
            <>
              <SidebarRow label="Cache screen on fold">
                <SidebarSwitch
                  label="Cache screen on fold"
                  checked={preview.cacheScreenOnFold}
                  onChange={preview.onCacheScreenOnFoldChange}
                />
              </SidebarRow>
              <SidebarRow label="Preview size">
                <Select
                  ariaLabel="Preview size"
                  options={PREVIEW_SIZE_OPTIONS}
                  value={preview.sizeMode}
                  onChange={preview.onSizeModeChange}
                />
              </SidebarRow>
            </>
          )}
        </>
      )}
      {error && (
        <div role="alert" style={{ ...textSize.xs, color: text.danger, padding: "0 0 12px" }}>
          {error}
        </div>
      )}
    </div>
  );
}
