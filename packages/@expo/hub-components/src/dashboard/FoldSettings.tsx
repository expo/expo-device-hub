import { useEffect, useId, useState } from 'react';

import { type DeviceHinge, type DuoPreviewMode } from '@expo/hub-client';
import { Select, type SelectOption, bg, border, radius, text, textSize } from '../primitives';
import { FOLD_POSE_OPTIONS, selectedFoldPose } from './foldPoses';
import { SidebarRow, SidebarSlider, SidebarSwitch } from './SidebarRow';

/** Viewer-local choices for how the iPhone Duo is drawn; owned by the consumer. */
export type FoldPreviewOption = {
  mode: DuoPreviewMode;
  onModeChange: (mode: DuoPreviewMode) => void;
  /** The model failed to load in this session; the flat screen shows until 3D is selected again. */
  unavailable?: boolean;
  /** Freeze the departing panel's last frame while the device folds. */
  cacheScreenOnFold: boolean;
  onCacheScreenOnFoldChange: (enabled: boolean) => void;
  /** Keep the model at its physical size, or fill the stage as the hinge moves. */
  sizeMode: 'physical' | 'fill';
  onSizeModeChange: (mode: 'physical' | 'fill') => void;
};

export const TABLE_MODE_DESCRIPTION =
  'Tells iOS the device rests on a table. Tent turns it on; rotation or hinge edits turn it off.';
export const TABLE_MODE_UNAVAILABLE_DESCRIPTION = 'Table Mode is not available in the current pose.';
export const MODEL_UNAVAILABLE_DESCRIPTION = '3D preview unavailable. Select 3D to retry.';

const PREVIEW_MODE_OPTIONS: ReadonlyArray<SelectOption<DuoPreviewMode>> = [
  { value: '3d', label: '3D' },
  { value: '2d', label: '2D' },
];

const PREVIEW_SIZE_OPTIONS: ReadonlyArray<SelectOption<'physical' | 'fill'>> = [
  { value: 'physical', label: 'Keep same size' },
  { value: 'fill', label: 'Fill available space' },
];

const SLIDER_WIDTH = 112;

/**
 * The iPhone Duo's fold controls, placed at the top of Device options like
 * serve-sim's Simulator settings: the five named poses, a live 0–180° hinge
 * slider with a decimal degree input, Table Mode, and the viewer's 2D/3D
 * preview choices. Every change waits for the helper's acknowledgement while
 * the controls stay enabled, so a slider drag feels live.
 */
export function FoldSettings({ hinge, preview }: { hinge: DeviceHinge; preview?: FoldPreviewOption }) {
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState('');
  const [angleDraft, setAngleDraft] = useState<number | null>(null);
  const [adjusting, setAdjusting] = useState(false);
  const tableModeDescriptionId = useId();
  const previewDescriptionId = useId();
  const { angle, pose, pending, error, tableMode, tableModeAvailable } = hinge;

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
  const selectedPose = angleDraft !== null ? null : selectedFoldPose(angle, pose);
  const poseValue = selectedPose ?? (displayedAngle === undefined ? 'unknown' : 'custom');
  const poseOptions: ReadonlyArray<SelectOption> =
    selectedPose === null
      ? [
          ...FOLD_POSE_OPTIONS,
          { value: poseValue, label: poseValue === 'unknown' ? 'Unknown' : 'Custom', disabled: true },
        ]
      : FOLD_POSE_OPTIONS;
  const canChangeTableMode = (tableModeAvailable ?? false) || tableMode === true;
  const viewMode: DuoPreviewMode = hinge.modelActive ? '3d' : '2d';
  const changeAngle = (value: number) => {
    setAngleDraft(value);
    hinge.setControl({ control: 'angle', value });
  };

  return (
    <div role="group" aria-label="Fold settings" aria-busy={pending || undefined}>
      <SidebarRow label="Fold pose">
        <Select
          ariaLabel="Fold pose"
          options={poseOptions}
          value={poseValue}
          onChange={(value) => {
            const position = FOLD_POSE_OPTIONS.find((option) => option.value === value);
            if (!position) return;
            setAngleDraft(null);
            setAdjusting(false);
            setEditing(false);
            hinge.setControl({ control: 'pose', value: position.value });
          }}
        />
      </SidebarRow>
      <SidebarRow label="Hinge angle">
        <span style={{ display: 'flex', minWidth: 0, alignItems: 'center', gap: 8 }}>
          <SidebarSlider
            label="Hinge angle"
            valueText={displayedAngle === undefined ? 'Unknown' : `${displayedAngle} degrees`}
            max={180}
            value={displayedAngle ?? 90}
            width={SLIDER_WIDTH}
            onChange={changeAngle}
            onAdjustStart={() => setAdjusting(true)}
            onAdjustEnd={() => setAdjusting(false)}
          />
          <input
            type="number"
            aria-label="Hinge angle in degrees"
            min={0}
            max={180}
            step="any"
            placeholder="—"
            value={editing ? draft : (displayedAngle ?? '')}
            onFocus={() => {
              setDraft(displayedAngle === undefined ? '' : String(displayedAngle));
              setEditing(true);
            }}
            onChange={(event) => {
              const { value, valueAsNumber } = event.currentTarget;
              setDraft(value);
              if (Number.isFinite(valueAsNumber) && valueAsNumber >= 0 && valueAsNumber <= 180) {
                changeAngle(valueAsNumber);
              }
            }}
            onBlur={() => setEditing(false)}
            onKeyDown={(event) => {
              if (event.key === 'Enter') event.currentTarget.blur();
            }}
            style={{
              ...textSize.sm,
              width: 56,
              boxSizing: 'border-box',
              padding: '4px 6px',
              border: `1px solid ${border.default}`,
              borderRadius: radius.md,
              backgroundColor: bg.default,
              color: text.default,
              fontFamily: 'inherit',
              textAlign: 'right',
            }}
          />
        </span>
      </SidebarRow>
      <SidebarRow
        label="Table Mode"
        description={canChangeTableMode ? TABLE_MODE_DESCRIPTION : TABLE_MODE_UNAVAILABLE_DESCRIPTION}
        descriptionId={tableModeDescriptionId}>
        <SidebarSwitch
          label="Table Mode"
          checked={tableMode ?? false}
          disabled={!canChangeTableMode}
          descriptionId={tableModeDescriptionId}
          onChange={(value) => hinge.setControl({ control: 'table', value })}
        />
      </SidebarRow>
      {preview && (
        <>
          <SidebarRow
            label="Preview mode"
            description={preview.unavailable ? MODEL_UNAVAILABLE_DESCRIPTION : undefined}
            descriptionId={preview.unavailable ? previewDescriptionId : undefined}>
            <Select
              ariaLabel="Preview mode"
              ariaDescribedBy={preview.unavailable ? previewDescriptionId : undefined}
              options={PREVIEW_MODE_OPTIONS}
              value={viewMode}
              onChange={preview.onModeChange}
            />
          </SidebarRow>
          {viewMode === '3d' && (
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
        <div role="alert" style={{ ...textSize.xs, color: text.danger, padding: '0 0 12px' }}>
          {error}
        </div>
      )}
    </div>
  );
}
