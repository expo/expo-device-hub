import { type CSSProperties, type ReactNode, useEffect, useMemo, useState } from 'react';

import {
  Button,
  CheckIcon,
  ChevronDownIcon,
  ChevronsUpDownIcon,
  DialogContent,
  DialogContentContainer,
  DialogFooter,
  DialogRoot,
  DialogTitle,
  SmartphoneIcon,
  bg,
  border,
  font,
  icon,
  radius,
  text,
} from '../primitives';
import { type Device, type NewDeviceOptions, type Platform } from './data';

/**
 * "Add a simulator" / "Add an emulator" picker (Option B in the design handoff),
 * styled with the existing Expo Hub design system — grayscale selection, the
 * shared `Dialog` chrome, and the standard `Button` primitives.
 *
 * One dialog, one primary action. The user either:
 *   - picks a recent device → "Boot" launches that existing device, or
 *   - edits the "New <kind>" form → "Boot" creates the configured device and
 *     boots it.
 * The target is mutually exclusive: selecting a recent de-activates the form, and
 * touching the form de-selects the recent.
 *
 * Both targets report through `onAdd`: a recent passes its own `Device`; a new
 * one passes a synthesized `Device` (real host-side create is still mocked, see
 * `handleBoot`). The form's OS-version/model options are mocked too (fed in via
 * `options`); recents carry a mocked `lastUsedAt` for the relative time shown.
 */
export type RecentDevicesModalProps = {
  open: boolean;
  onClose: () => void;
  /** Drives the nouns ("simulator"/"emulator") and the synthesized platform. */
  kind: 'simulator' | 'emulator';
  /** Recents to offer (already filtered to those not shown in the sidebar). */
  devices: Device[];
  /** Mocked OS versions + models for the "New <kind>" form selects. */
  options: NewDeviceOptions;
  /** Boots the chosen target (existing recent, or synthesized new device). */
  onAdd: (device: Device) => void;
};

/** The active boot target — exactly one at a time. */
type Target = { kind: 'recent'; id: string } | { kind: 'new' };

export function RecentDevicesModal({
  open,
  onClose,
  kind,
  devices,
  options,
  onAdd,
}: RecentDevicesModalProps) {
  const platform: Platform = kind === 'simulator' ? 'ios' : 'android';
  const noun = kind; // "simulator" | "emulator"
  const title = `Add a${kind === 'emulator' ? 'n' : ''} ${noun}`;

  // Most-recently-used first, so the top row is the natural default selection.
  const recents = useMemo(
    () => [...devices].sort((a, b) => (b.lastUsedAt ?? 0) - (a.lastUsedAt ?? 0)),
    [devices],
  );

  const [target, setTarget] = useState<Target>({ kind: 'new' });
  const [osVersion, setOsVersion] = useState('');
  const [model, setModel] = useState('');
  const [name, setName] = useState('');
  // Once the user edits the name we stop auto-deriving it from the model.
  const [nameEdited, setNameEdited] = useState(false);
  const [nameFocused, setNameFocused] = useState(false);

  // Reset to a clean state each time the dialog opens. Keyed on `open` only so
  // selecting/editing while open isn't clobbered by parent re-renders (the
  // `devices`/`options` props are fresh arrays on every render).
  useEffect(() => {
    if (!open) return;
    const firstOs = options.osVersions[0] ?? '';
    const firstModel = options.models[0] ?? '';
    setOsVersion(firstOs);
    setModel(firstModel);
    setName(suggestName(firstModel, recents));
    setNameEdited(false);
    setNameFocused(false);
    // Default target: the most-recently-used recent, else the new-device form.
    setTarget(recents.length ? { kind: 'recent', id: recents[0].id } : { kind: 'new' });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open]);

  const isNew = target.kind === 'new';
  const selectedRecent =
    target.kind === 'recent' ? recents.find((device) => device.id === target.id) : undefined;

  const activateNew = () => setTarget({ kind: 'new' });

  function handleModelChange(next: string) {
    setModel(next);
    activateNew();
    if (!nameEdited) setName(suggestName(next, recents));
  }

  function handleNameChange(next: string) {
    setName(next);
    setNameEdited(true);
    activateNew();
  }

  const canBoot = isNew ? name.trim().length > 0 : !!selectedRecent;

  function handleBoot() {
    if (!canBoot) return;
    if (isNew) {
      // MOCK: real host-side create+boot isn't wired up yet. Synthesize a Device
      // so the new one joins the sidebar and gets selected, mirroring the recent
      // path. Swap for a real "create simulator" call when one exists.
      const newName = name.trim();
      onAdd({
        id: `new:${platform}:${newName}`,
        name: newName,
        version: osVersion,
        platform,
        booted: false,
      });
    } else if (selectedRecent) {
      onAdd(selectedRecent);
    }
    onClose();
  }

  return (
    <DialogRoot
      open={open}
      onOpenChange={(next) => {
        if (!next) onClose();
      }}>
      <DialogContent>
        <DialogTitle title={title} />
        <DialogContentContainer>
          <SectionLabel>Recents</SectionLabel>
          <div style={{ display: 'flex', flexDirection: 'column', gap: 3 }}>
            {recents.length === 0 ? (
              <p style={{ margin: 0, padding: '2px 2px 6px 2px', fontSize: 13, color: text.tertiary }}>
                No recent {noun}s.
              </p>
            ) : (
              recents.map((device) => (
                <RecentRow
                  key={device.id}
                  device={device}
                  selected={target.kind === 'recent' && target.id === device.id}
                  onSelect={() => setTarget({ kind: 'recent', id: device.id })}
                />
              ))
            )}
          </div>

          {/*<div style={{ marginTop: 10 }}>
            <SectionLabel active={isNew}>New {noun}</SectionLabel>
            <div
              onClick={activateNew}
              style={{
                borderRadius: radius.lg,
                overflow: 'hidden',
                backgroundColor: bg.subtle,
                border: `1px solid ${isNew ? border.default : border.secondary}`,
                transition: 'border-color 150ms ease',
              }}>
              <FormRow label="Name" last={false}>
                <input
                  type="text"
                  value={name}
                  placeholder={model || `New ${noun}`}
                  onChange={(event) => handleNameChange(event.currentTarget.value)}
                  onFocus={() => {
                    setNameFocused(true);
                    activateNew();
                  }}
                  onBlur={() => setNameFocused(false)}
                  style={{
                    width: '100%',
                    boxSizing: 'border-box',
                    padding: '6px 10px',
                    border: `1px solid ${border.default}`,
                    borderRadius: radius.md,
                    backgroundColor: bg.default,
                    color: isNew ? text.default : text.tertiary,
                    caretColor: text.default,
                    fontSize: 13.5,
                    fontFamily: 'inherit',
                    outline: 'none',
                    boxShadow: nameFocused ? `0 0 0 3px ${bg.element}` : 'none',
                  }}
                />
              </FormRow>
              <FormRow label="OS version" last={false}>
                <SelectField
                  value={osVersion}
                  options={options.osVersions}
                  onChange={(next) => {
                    setOsVersion(next);
                    activateNew();
                  }}
                  onActivate={activateNew}
                  trailing={<ChevronDownIcon size={14} color={icon.secondary} />}
                />
              </FormRow>
              <FormRow label="Model" last>
                <SelectField
                  value={model}
                  options={options.models}
                  onChange={handleModelChange}
                  onActivate={activateNew}
                  trailing={<ChevronsUpDownIcon size={14} color={icon.secondary} />}
                />
              </FormRow>
            </div>
          </div>*/}
        </DialogContentContainer>
        <DialogFooter>
          <Button theme="quaternary" onClick={onClose}>
            Cancel
          </Button>
          <Button theme="primary" disabled={!canBoot} onClick={handleBoot}>
            Boot
          </Button>
        </DialogFooter>
      </DialogContent>
    </DialogRoot>
  );
}

/** Mono uppercase section label ("Recents" / "New simulator"). */
function SectionLabel({ children, active = false }: { children: ReactNode; active?: boolean }) {
  return (
    <span
      style={{
        display: 'block',
        marginBottom: 4,
        fontFamily: font.mono,
        fontSize: 11,
        fontWeight: active ? 600 : 400,
        letterSpacing: '0.06em',
        textTransform: 'uppercase',
        color: active ? text.default : text.tertiary,
      }}>
      {children}
    </span>
  );
}

/** A selectable recent device row: icon (✓ when selected), name + status, OS pill. */
function RecentRow({
  device,
  selected,
  onSelect,
}: {
  device: Device;
  selected: boolean;
  onSelect: () => void;
}) {
  const [hovered, setHovered] = useState(false);

  return (
    <button
      type="button"
      aria-pressed={selected}
      onClick={onSelect}
      onMouseEnter={() => setHovered(true)}
      onMouseLeave={() => setHovered(false)}
      style={{
        display: 'flex',
        alignItems: 'center',
        gap: 12,
        width: '100%',
        padding: '9px 11px',
        border: 'none',
        borderRadius: radius.lg,
        textAlign: 'left',
        fontFamily: 'inherit',
        cursor: 'pointer',
        backgroundColor: selected ? bg.hover : hovered ? bg.element : 'transparent',
        transition: 'background-color 150ms ease',
      }}>
      <span
        style={{
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'center',
          width: 31,
          height: 31,
          flex: '0 0 auto',
          borderRadius: radius.lg,
          backgroundColor: bg.element,
          color: selected ? text.default : icon.default,
        }}>
        {selected ? <CheckIcon size={16} /> : <SmartphoneIcon size={16} />}
      </span>
      <span style={{ display: 'flex', flexDirection: 'column', gap: 2, minWidth: 0 }}>
        <span
          style={{
            fontSize: 14,
            fontWeight: selected ? 600 : 500,
            color: text.default,
            lineHeight: 1.25,
          }}>
          {device.name}
        </span>
        <span
          style={{
            display: 'flex',
            alignItems: 'center',
            gap: 6,
            fontSize: 12,
            color: text.tertiary,
            lineHeight: 1.25,
          }}>
          <span
            style={{
              width: 6,
              height: 6,
              flex: '0 0 auto',
              borderRadius: '50%',
              backgroundColor: device.booted ? icon.success : icon.quaternary,
            }}
          />
          {device.booted ? 'Booted · now' : relativeLastUsed(device.lastUsedAt)}
        </span>
      </span>
      <span
        style={{
          marginLeft: 'auto',
          flex: '0 0 auto',
          fontSize: 11,
          color: text.secondary,
          backgroundColor: bg.element,
          borderRadius: radius.full,
          padding: '3px 9px',
          fontVariantNumeric: 'tabular-nums',
          whiteSpace: 'nowrap',
        }}>
        {device.version}
      </span>
    </button>
  );
}

/** A label/control row inside the new-device form card. */
function FormRow({ label, last, children }: { label: string; last: boolean; children: ReactNode }) {
  return (
    <div
      style={{
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'space-between',
        gap: 12,
        padding: '11px 13px',
        borderBottom: last ? undefined : `1px solid ${border.secondary}`,
      }}>
      <span style={{ fontSize: 13, color: text.secondary }}>{label}</span>
      {children}
    </div>
  );
}

/** Native select styled as a bordered field with a custom trailing chevron. */
function SelectField({
  value,
  options,
  onChange,
  onActivate,
  trailing,
}: {
  value: string;
  options: string[];
  onChange: (value: string) => void;
  onActivate: () => void;
  trailing: ReactNode;
}) {
  const [focused, setFocused] = useState(false);

  const selectStyle: CSSProperties = {
    width: '100%',
    boxSizing: 'border-box',
    padding: '6px 28px 6px 10px',
    border: `1px solid ${border.default}`,
    borderRadius: radius.md,
    backgroundColor: bg.default,
    color: text.default,
    fontSize: 13.5,
    fontFamily: 'inherit',
    appearance: 'none',
    WebkitAppearance: 'none',
    MozAppearance: 'none',
    outline: 'none',
    cursor: 'pointer',
    boxShadow: focused ? `0 0 0 3px ${bg.element}` : 'none',
  };

  return (
    <div style={{ position: 'relative', flex: '0 0 58%' }}>
      <select
        value={value}
        onChange={(event) => onChange(event.currentTarget.value)}
        onMouseDown={onActivate}
        onFocus={() => {
          setFocused(true);
          onActivate();
        }}
        onBlur={() => setFocused(false)}
        style={selectStyle}>
        {options.length === 0 ? (
          <option value="">—</option>
        ) : (
          options.map((option) => (
            <option key={option} value={option}>
              {option}
            </option>
          ))
        )}
      </select>
      <span
        style={{
          position: 'absolute',
          right: 10,
          top: '50%',
          transform: 'translateY(-50%)',
          pointerEvents: 'none',
          display: 'flex',
          color: icon.secondary,
        }}>
        {trailing}
      </span>
    </div>
  );
}

/** Default name for a new device: the model, with the next free integer suffix. */
function suggestName(model: string, existing: Device[]): string {
  if (!model) return '';
  const taken = new Set(existing.map((device) => device.name));
  if (!taken.has(model)) return model;
  let n = 2;
  while (taken.has(`${model} ${n}`)) n++;
  return `${model} ${n}`;
}

/** "now" / "18m ago" / "1h ago" / "2 days ago" / "1 week ago" from an epoch ms. */
function relativeLastUsed(lastUsedAt?: number): string {
  if (!lastUsedAt) return 'Idle';
  const diffMs = Date.now() - lastUsedAt;
  const minutes = Math.round(diffMs / 60_000);
  if (minutes < 1) return 'now';
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.round(minutes / 60);
  if (hours < 24) return `${hours}h ago`;
  const days = Math.round(hours / 24);
  if (days < 7) return `${days} day${days === 1 ? '' : 's'} ago`;
  const weeks = Math.round(days / 7);
  if (weeks < 5) return `${weeks} week${weeks === 1 ? '' : 's'} ago`;
  const months = Math.round(days / 30);
  return `${months} month${months === 1 ? '' : 's'} ago`;
}
