import {
  type CSSProperties,
  type FormEvent,
  type ReactNode,
  useEffect,
  useMemo,
  useState,
} from 'react';

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
import {
  type AddDeviceOutcome,
  type AddDeviceTarget,
  type Device,
  type NewDeviceOptions,
  type Platform,
} from './data';

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
 * Both targets report through `onAdd`: a recent passes its existing `Device`;
 * a new target passes the selected host toolchain identifiers. The dialog stays
 * open while the async request runs and only closes after the host confirms the
 * device is booted.
 */
export type RecentDevicesModalProps = {
  open: boolean;
  onClose: () => void;
  /** Drives the nouns ("simulator"/"emulator") and the synthesized platform. */
  kind: 'simulator' | 'emulator';
  /** Recents to offer (already filtered to those not shown in the sidebar). */
  devices: Device[];
  /** Installed runtimes/system images and their compatible device models. */
  options: NewDeviceOptions;
  /** Boots the chosen target or creates and boots a new device on the host. */
  onAdd: (target: AddDeviceTarget) => Promise<AddDeviceOutcome>;
};

/** The active boot target — exactly one at a time. */
type Target = { kind: 'recent'; id: string } | { kind: 'new' };

const ANDROID_AVD_NAME_PATTERN = /^[A-Za-z0-9._-]+$/;
const ANDROID_AVD_NAME_HINT = 'Allowed: a-z A-Z 0-9 . _ -';

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
    [devices]
  );

  const [target, setTarget] = useState<Target>({ kind: 'new' });
  const [runtime, setRuntime] = useState('');
  const [model, setModel] = useState('');
  const [name, setName] = useState('');
  // Once the user edits the name we stop auto-deriving it from the model.
  const [nameEdited, setNameEdited] = useState(false);
  const [nameFocused, setNameFocused] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const [submissionError, setSubmissionError] = useState<string | null>(null);

  // Reset to a clean state each time the dialog opens, and initialize again if
  // async host discovery resolves while an already-open dialog is still empty.
  // The options object is stable after loading, so ordinary parent re-renders
  // do not clobber in-progress edits.
  useEffect(() => {
    if (!open) return;
    const firstRuntime = options.runtimes[0];
    const firstModel = firstRuntime?.models[0];
    setRuntime(firstRuntime?.value ?? '');
    setModel(firstModel?.value ?? '');
    setName(suggestName(firstModel?.label ?? '', recents, platform));
    setNameEdited(false);
    setNameFocused(false);
    setSubmitting(false);
    setSubmissionError(null);
    // Default target: the most-recently-used recent, else the new-device form.
    setTarget(recents.length ? { kind: 'recent', id: recents[0].id } : { kind: 'new' });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, options]);

  const isNew = target.kind === 'new';
  const selectedRecent =
    target.kind === 'recent' ? recents.find((device) => device.id === target.id) : undefined;
  const allModelOptions = useMemo(() => {
    const models = new Map<string, NewDeviceOptions['runtimes'][number]['models'][number]>();
    for (const runtimeOption of options.runtimes) {
      for (const modelOption of runtimeOption.models) {
        if (!models.has(modelOption.value)) models.set(modelOption.value, modelOption);
      }
    }
    return [...models.values()].sort((a, b) =>
      a.label.localeCompare(b.label, undefined, { numeric: true })
    );
  }, [options.runtimes]);
  const runtimeOptions =
    platform === 'android'
      ? options.runtimes.filter((option) =>
          option.models.some((modelOption) => modelOption.value === model)
        )
      : options.runtimes;
  const selectedRuntime = runtimeOptions.find((option) => option.value === runtime);
  const modelOptions =
    platform === 'android' ? allModelOptions : (selectedRuntime?.models ?? []);
  const selectedModel = selectedRuntime?.models.find((option) => option.value === model);

  const activateNew = () => {
    setTarget({ kind: 'new' });
    setSubmissionError(null);
  };

  function handleRuntimeChange(next: string) {
    const nextRuntime = options.runtimes.find((option) => option.value === next);
    setRuntime(next);
    activateNew();
    if (platform === 'ios') {
      const firstModel = nextRuntime?.models[0];
      setModel(firstModel?.value ?? '');
      if (!nameEdited) setName(suggestName(firstModel?.label ?? '', recents, platform));
    }
  }

  function handleModelChange(next: string) {
    setModel(next);
    activateNew();
    const nextModel = modelOptions.find((option) => option.value === next);
    if (platform === 'android') {
      const firstCompatibleRuntime = options.runtimes.find((option) =>
        option.models.some((modelOption) => modelOption.value === next)
      );
      setRuntime(firstCompatibleRuntime?.value ?? '');
    }
    if (!nameEdited) setName(suggestName(nextModel?.label ?? '', recents, platform));
  }

  function handleNameChange(next: string) {
    setName(next);
    setNameEdited(true);
    activateNew();
  }

  const trimmedName = name.trim();
  const nameIsValid =
    trimmedName.length > 0 &&
    (platform !== 'android' || ANDROID_AVD_NAME_PATTERN.test(trimmedName));
  const hasInvalidAndroidName =
    platform === 'android' &&
    nameEdited &&
    trimmedName.length > 0 &&
    !ANDROID_AVD_NAME_PATTERN.test(trimmedName);
  const nameHintId = `new-${platform}-device-name-hint`;
  const canBoot = isNew
    ? nameIsValid && runtime.length > 0 && model.length > 0
    : !!selectedRecent;

  async function handleBoot(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!canBoot || submitting) return;

    setSubmitting(true);
    setSubmissionError(null);
    try {
      const addTarget: AddDeviceTarget =
        isNew && selectedRuntime && selectedModel
          ? {
              kind: 'new',
              device: {
                platform,
                name: trimmedName,
                runtime: selectedRuntime.value,
                deviceType: selectedModel.value,
                version: selectedRuntime.label,
                supported: selectedModel.supported,
                deviceFrame: selectedModel.deviceFrame,
              },
            }
          : { kind: 'recent', device: selectedRecent! };
      const outcome = await onAdd(addTarget);
      if (outcome.ok) {
        onClose();
      } else {
        setSubmissionError(outcome.error);
      }
    } catch (error) {
      setSubmissionError(error instanceof Error ? error.message : String(error));
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <DialogRoot
      open={open}
      onOpenChange={(next) => {
        if (!next) onClose();
      }}>
      <DialogContent>
        <DialogTitle title={title} />
        <form onSubmit={handleBoot}>
          <DialogContentContainer>
            <SectionLabel>Recents</SectionLabel>
            <div style={{ display: 'flex', flexDirection: 'column', gap: 3 }}>
              {recents.length === 0 ? (
                <p
                  style={{
                    margin: 0,
                    padding: '2px 2px 6px 2px',
                    fontSize: 13,
                    color: text.tertiary,
                  }}>
                  No recent {noun}s.
                </p>
              ) : (
                recents.map((device) => (
                  <RecentRow
                    key={device.id}
                    device={device}
                    selected={target.kind === 'recent' && target.id === device.id}
                    onSelect={() => {
                      setTarget({ kind: 'recent', id: device.id });
                      setSubmissionError(null);
                    }}
                  />
                ))
              )}
            </div>

            <div style={{ marginTop: 10 }}>
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
                {options.runtimes.length === 0 ? (
                  <p style={{ margin: 0, padding: 13, color: text.tertiary, fontSize: 13 }}>
                    No usable {platform === 'ios' ? 'iOS runtimes' : 'Android system images'} were
                    found on this host.
                  </p>
                ) : (
                  <>
                    <FormRow
                      label={
                        <>
                          <span>Name</span>
                          {platform === 'android' && (
                            <span
                              id={nameHintId}
                              style={{
                                color: hasInvalidAndroidName ? text.danger : text.tertiary,
                                fontSize: 11,
                                lineHeight: 1.3,
                              }}>
                              {ANDROID_AVD_NAME_HINT}
                            </span>
                          )}
                        </>
                      }
                      htmlFor={`new-${platform}-device-name`}
                      last={false}>
                      <div style={{ flex: '0 0 58%' }}>
                        <input
                          id={`new-${platform}-device-name`}
                          type="text"
                          value={name}
                          placeholder={selectedModel?.label || `New ${noun}`}
                          autoComplete="off"
                          spellCheck={false}
                          pattern={platform === 'android' ? '[A-Za-z0-9._-]+' : undefined}
                          title={platform === 'android' ? ANDROID_AVD_NAME_HINT : undefined}
                          aria-invalid={hasInvalidAndroidName ? true : undefined}
                          aria-describedby={platform === 'android' ? nameHintId : undefined}
                          disabled={submitting}
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
                            border: `1px solid ${
                              hasInvalidAndroidName ? border.danger : border.default
                            }`,
                            borderRadius: radius.md,
                            backgroundColor: bg.default,
                            color: isNew ? text.default : text.tertiary,
                            caretColor: text.default,
                            fontSize: 16,
                            fontFamily: 'inherit',
                            outline: 'none',
                            boxShadow: nameFocused ? `0 0 0 3px ${bg.element}` : 'none',
                          }}
                        />
                      </div>
                    </FormRow>
                    {platform === 'android' ? (
                      <>
                        <FormRow label="Model" htmlFor={`new-${platform}-model`} last={false}>
                          <SelectField
                            id={`new-${platform}-model`}
                            value={model}
                            options={modelOptions}
                            disabled={submitting}
                            onChange={handleModelChange}
                            onActivate={activateNew}
                            trailing={<ChevronsUpDownIcon size={14} color={icon.secondary} />}
                          />
                        </FormRow>
                        <FormRow label="OS version" htmlFor={`new-${platform}-runtime`} last>
                          <SelectField
                            id={`new-${platform}-runtime`}
                            value={runtime}
                            options={runtimeOptions}
                            disabled={submitting}
                            onChange={handleRuntimeChange}
                            onActivate={activateNew}
                            trailing={<ChevronDownIcon size={14} color={icon.secondary} />}
                          />
                        </FormRow>
                      </>
                    ) : (
                      <>
                        <FormRow
                          label="OS version"
                          htmlFor={`new-${platform}-runtime`}
                          last={false}>
                          <SelectField
                            id={`new-${platform}-runtime`}
                            value={runtime}
                            options={runtimeOptions}
                            disabled={submitting}
                            onChange={handleRuntimeChange}
                            onActivate={activateNew}
                            trailing={<ChevronDownIcon size={14} color={icon.secondary} />}
                          />
                        </FormRow>
                        <FormRow label="Model" htmlFor={`new-${platform}-model`} last>
                          <SelectField
                            id={`new-${platform}-model`}
                            value={model}
                            options={modelOptions}
                            disabled={submitting}
                            onChange={handleModelChange}
                            onActivate={activateNew}
                            trailing={<ChevronsUpDownIcon size={14} color={icon.secondary} />}
                          />
                        </FormRow>
                      </>
                    )}
                  </>
                )}
              </div>
            </div>

            {submissionError && (
              <p
                role="alert"
                style={{
                  margin: '12px 0 0',
                  padding: '9px 11px',
                  border: `1px solid ${border.danger}`,
                  borderRadius: radius.lg,
                  backgroundColor: bg.danger,
                  color: text.danger,
                  fontSize: 13,
                  whiteSpace: 'pre-wrap',
                }}>
                {submissionError}
              </p>
            )}
          </DialogContentContainer>
          <DialogFooter>
            <Button type="button" theme="quaternary" disabled={submitting} onClick={onClose}>
              Cancel
            </Button>
            <Button type="submit" theme="primary" disabled={!canBoot || submitting}>
              {submitting ? (isNew ? 'Creating…' : 'Booting…') : isNew ? 'Create & Boot' : 'Boot'}
            </Button>
          </DialogFooter>
        </form>
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
function FormRow({
  label,
  htmlFor,
  last,
  children,
}: {
  label: ReactNode;
  htmlFor: string;
  last: boolean;
  children: ReactNode;
}) {
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
      <label
        htmlFor={htmlFor}
        style={{
          display: 'flex',
          flexDirection: 'column',
          gap: 2,
          fontSize: 13,
          color: text.secondary,
          cursor: 'pointer',
        }}>
        {label}
      </label>
      {children}
    </div>
  );
}

/** Native select styled as a bordered field with a custom trailing chevron. */
function SelectField({
  id,
  value,
  options,
  disabled,
  onChange,
  onActivate,
  trailing,
}: {
  id: string;
  value: string;
  options: { value: string; label: string }[];
  disabled: boolean;
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
    fontSize: 16,
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
        id={id}
        value={value}
        disabled={disabled}
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
            <option key={option.value} value={option.value}>
              {option.label}
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
function suggestName(model: string, existing: Device[], platform: Platform): string {
  const base =
    platform === 'android'
      ? model
          .trim()
          .replace(/[^A-Za-z0-9._-]+/g, '_')
          .replace(/^_+|_+$/g, '')
      : model;
  if (!base) return '';
  const taken = new Set(existing.map((device) => device.name));
  if (!taken.has(base)) return base;
  let n = 2;
  const separator = platform === 'android' ? '_' : ' ';
  while (taken.has(`${base}${separator}${n}`)) n++;
  return `${base}${separator}${n}`;
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
