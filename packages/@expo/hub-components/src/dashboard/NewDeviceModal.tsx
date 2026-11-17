import {
  type FormEvent,
  type ReactNode,
  type RefObject,
  useId,
  useMemo,
  useRef,
  useState,
} from "react";

import {
  Button,
  Modal,
  PRESSABLE_CLASS,
  Select,
  bg,
  fieldControlProps,
  text,
  textSize,
  tone,
} from "../primitives";
import {
  type AddDeviceOutcome,
  type AddDeviceTarget,
  type Device,
  type NewDeviceOptions,
  type Platform,
} from "./data";
import { ANDROID_AVD_NAME_HINT, isValidDeviceName, suggestDeviceName } from "./new-device";

export type NewDeviceModalProps = {
  open: boolean;
  onClose: () => void;
  /** Drives the nouns ("simulator" / "emulator") and the platform of the new device. */
  kind: "simulator" | "emulator";
  /** The devices that exist, so that the suggested name is free. */
  existing: Device[];
  /** Installed runtimes/system images and their compatible device models. */
  options: NewDeviceOptions;
  /** Creates and boots the configured device on the host. */
  onAdd: (target: AddDeviceTarget) => Promise<AddDeviceOutcome>;
};

/**
 * "New simulator" / "New emulator": the form that creates a device and boots
 * it, from the dashboard design. It stays open while the host works and
 * closes when the device is booted; a failure shows above the button.
 *
 * The form starts fresh each time it opens, because the dialog mounts it only
 * while it is open.
 */
export function NewDeviceModal({ open, onClose, kind, ...form }: NewDeviceModalProps) {
  // The form opens with the name ready to type, as in the design.
  const nameRef = useRef<HTMLInputElement>(null);
  return (
    <Modal open={open} onClose={onClose} title={`New ${kind}`} initialFocus={nameRef}>
      <NewDeviceForm kind={kind} onClose={onClose} nameRef={nameRef} {...form} />
    </Modal>
  );
}

/** The form of {@link NewDeviceModal}. Exported for tests, which cannot render the dialog's portal. */
export function NewDeviceForm({
  kind,
  existing,
  options,
  onAdd,
  onClose,
  nameRef,
}: Omit<NewDeviceModalProps, "open"> & { nameRef?: RefObject<HTMLInputElement | null> }) {
  const platform: Platform = kind === "simulator" ? "ios" : "android";
  const firstRuntime = options.runtimes[0];
  const firstModel = firstRuntime?.models[0];
  // The model is free on Android and narrows the system images. On iOS the runtime narrows the models.
  const [runtime, setRuntime] = useState(firstRuntime?.value ?? "");
  const [model, setModel] = useState(firstModel?.value ?? "");
  // An empty name means the suggested one, which follows the model until the viewer types.
  const [typedName, setTypedName] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);
  const [submissionError, setSubmissionError] = useState<string | null>(null);
  const ids = { name: useId(), runtime: useId(), model: useId(), hint: useId() };

  const allModels = useMemo(() => {
    const models = new Map<string, NewDeviceOptions["runtimes"][number]["models"][number]>();
    for (const runtimeOption of options.runtimes) {
      for (const modelOption of runtimeOption.models) {
        if (!models.has(modelOption.value)) models.set(modelOption.value, modelOption);
      }
    }
    return [...models.values()].sort((a, b) =>
      a.label.localeCompare(b.label, undefined, { numeric: true }),
    );
  }, [options.runtimes]);
  const runtimeOptions =
    platform === "android"
      ? options.runtimes.filter((option) => option.models.some((item) => item.value === model))
      : options.runtimes;
  const selectedRuntime = runtimeOptions.find((option) => option.value === runtime);
  const modelOptions = platform === "android" ? allModels : (selectedRuntime?.models ?? []);
  const selectedModel = selectedRuntime?.models.find((option) => option.value === model);
  const suggestedName = suggestDeviceName(selectedModel?.label ?? "", existing, platform);
  const name = (typedName ?? suggestedName).trim();
  const invalidName = typedName !== null && name.length > 0 && !isValidDeviceName(name, platform);
  const canCreate = isValidDeviceName(name, platform) && !!selectedRuntime && !!selectedModel;

  function chooseRuntime(next: string) {
    setRuntime(next);
    setSubmissionError(null);
    if (platform === "ios") {
      const nextRuntime = options.runtimes.find((option) => option.value === next);
      setModel(nextRuntime?.models[0]?.value ?? "");
    }
  }

  function chooseModel(next: string) {
    setModel(next);
    setSubmissionError(null);
    if (platform === "android") {
      const compatible = options.runtimes.find((option) =>
        option.models.some((item) => item.value === next),
      );
      setRuntime(compatible?.value ?? "");
    }
  }

  async function create(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!canCreate || submitting || !selectedRuntime || !selectedModel) return;
    setSubmitting(true);
    setSubmissionError(null);
    try {
      const outcome = await onAdd({
        kind: "new",
        device: {
          platform,
          name,
          runtime: selectedRuntime.value,
          deviceType: selectedModel.value,
          version: selectedRuntime.label,
          supported: selectedModel.supported,
          // The picker shows the iOS device type name and keeps the AVD profile id as the value.
          model: platform === "ios" ? selectedModel.label : selectedModel.value,
        },
      });
      if (outcome.ok) onClose();
      else setSubmissionError(outcome.error);
    } catch (error) {
      setSubmissionError(error instanceof Error ? error.message : String(error));
    } finally {
      setSubmitting(false);
    }
  }

  if (options.runtimes.length === 0) {
    return (
      <p style={{ ...textSize.sm, margin: 0, color: text.secondary }}>
        No usable {platform === "ios" ? "iOS runtimes" : "Android system images"} were found on this
        host.
      </p>
    );
  }

  const nameField = fieldControlProps({ disabled: submitting, interactive: false, size: "lg" });
  const runtimeSelect = (
    <FormField key="runtime" label="OS version" htmlFor={ids.runtime}>
      <Select
        id={ids.runtime}
        size="lg"
        ariaLabel="OS version"
        value={runtime}
        options={runtimeOptions}
        disabled={submitting}
        onChange={chooseRuntime}
      />
    </FormField>
  );
  const modelSelect = (
    <FormField key="model" label="Model" htmlFor={ids.model}>
      <Select
        id={ids.model}
        size="lg"
        ariaLabel="Model"
        value={model}
        options={modelOptions}
        disabled={submitting}
        onChange={chooseModel}
      />
    </FormField>
  );

  return (
    <form onSubmit={create} style={{ display: "flex", flexDirection: "column" }}>
      <FormField
        label="Name"
        htmlFor={ids.name}
        hint={platform === "android" ? ANDROID_AVD_NAME_HINT : undefined}
        hintId={ids.hint}
        invalid={invalidName}
      >
        <input
          ref={nameRef}
          id={ids.name}
          type="text"
          value={typedName ?? ""}
          placeholder={suggestedName || `New ${kind}`}
          autoComplete="off"
          spellCheck={false}
          aria-invalid={invalidName || undefined}
          aria-describedby={platform === "android" ? ids.hint : undefined}
          disabled={submitting}
          onChange={(event) => {
            setTypedName(event.currentTarget.value === "" ? null : event.currentTarget.value);
            setSubmissionError(null);
          }}
          className={PRESSABLE_CLASS}
          style={{
            ...nameField.style,
            display: "block",
            borderColor: invalidName ? tone.danger.border : undefined,
            cursor: submitting ? "default" : "text",
            caretColor: text.default,
          }}
        />
      </FormField>
      {/* Android picks the model first: it narrows the system images. iOS picks the runtime first. */}
      {platform === "android" ? [modelSelect, runtimeSelect] : [runtimeSelect, modelSelect]}
      {submissionError && (
        <p
          role="alert"
          style={{
            ...textSize.sm,
            margin: "0 0 16px",
            padding: "8px 12px",
            border: `1px solid ${tone.danger.border}`,
            borderRadius: 12,
            backgroundColor: tone.danger.bg,
            color: tone.danger.text,
            whiteSpace: "pre-wrap",
          }}
        >
          {submissionError}
        </p>
      )}
      <Button type="submit" theme="primary" size="xl" block disabled={!canCreate || submitting}>
        {submitting ? "Creating…" : "Create"}
      </Button>
    </form>
  );
}

/** A labeled control of the form, with one line under it for a hint. */
function FormField({
  label,
  htmlFor,
  hint,
  hintId,
  invalid = false,
  children,
}: {
  label: string;
  htmlFor: string;
  hint?: string;
  hintId?: string;
  invalid?: boolean;
  children: ReactNode;
}) {
  return (
    // The class darkens the label while the control has focus, as in the design.
    <div className="hub-form-field" style={{ display: "flex", flexDirection: "column", gap: 8 }}>
      <label
        htmlFor={htmlFor}
        // The class holds the color, which an inline style would fix in place.
        className="hub-form-label"
        style={{ ...textSize.sm, lineHeight: "20px", fontWeight: 500 }}
      >
        {label}
      </label>
      {children}
      {/* The line keeps its height without a hint, so every field ends at the same distance. */}
      <span
        id={hintId}
        style={{
          ...textSize.xs,
          minHeight: 16,
          marginBottom: 16,
          lineHeight: "16px",
          color: invalid ? tone.danger.text : text.tertiary,
          backgroundColor: bg.screen,
        }}
      >
        {hint}
      </span>
    </div>
  );
}
