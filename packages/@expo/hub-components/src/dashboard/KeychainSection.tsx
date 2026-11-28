import { useEffect, useRef, useState } from "react";

import {
  type DeviceClient,
  type KeychainFormat,
  type KeychainOptions,
  type KeychainWriteResult,
} from "@expo/hub-client";
import { Button, Select } from "../primitives";
import { errorMessage } from "./browserClipboard";
import { CollapsibleSection } from "./CollapsibleSection";
import {
  KEYCHAIN_FORMAT_OPTIONS,
  KEYCHAIN_FORMAT_UI,
  describeKeychainWrite,
  displayKeychainIdentifier,
  missingKeychainField,
  parseKeychainDraft,
} from "./keychainInput";
import { SectionNote } from "./SectionNote";
import { SidebarRow } from "./SidebarRow";
import { SidebarTextArea } from "./SidebarTextArea";
import { SidebarTextInput } from "./SidebarTextInput";

const GROUP_STYLE = { padding: "4px 0 8px" } as const;
const BUTTONS_STYLE = { display: "flex", gap: 8, padding: "4px 0 8px" } as const;
// The home screen is in the foreground, not an app with a keychain of its own.
const HOME_SCREEN = "com.apple.springboard";
// serve-sim reaches the keychain of user apps only, not of system apps such as Safari.
const SYSTEM_APP_PREFIX = "com.apple.";

// @ref LLP 0020#hub-ui — single-line inputs can silently drop line breaks from a paste.
function rejectMultilinePaste(text: string, setRejected: (rejected: boolean) => void): boolean {
  const rejected = /[\r\n]/.test(text);
  setRejected(rejected);
  return rejected;
}

/**
 * Keychain values of the foreground app, in the layout of a library it uses: list its keys, set
 * values such as sign-in tokens, and delete them. Values are never read back.
 */
export function KeychainSection({
  client,
  defaultOpen = false,
}: {
  client?: DeviceClient;
  /** Whether the section is initially expanded. */
  defaultOpen?: boolean;
}) {
  const [open, setOpen] = useState(defaultOpen);
  const [key, setKey] = useState("");
  const [value, setValue] = useState("");
  const [format, setFormat] = useState<KeychainFormat>("expo-secure-store");
  // The format's field, such as the service the app passes.
  const [fieldValue, setFieldValue] = useState("");
  const [fieldPasteRejected, setFieldPasteRejected] = useState(false);
  const [keyPasteRejected, setKeyPasteRejected] = useState(false);
  // The options the keys are listed with, so a Delete goes where they were read. Typing in the
  // field does not change it; a new format, Enter in the field, or a Set does. A new object lists
  // the keys again.
  const [query, setQuery] = useState<KeychainOptions>({ format: "expo-secure-store" });
  const [keys, setKeys] = useState<string[] | null>(null);
  const [listError, setListError] = useState<string | null>(null);
  const [pending, setPending] = useState<string | null>(null);
  const [note, setNote] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const foreground = client?.foregroundApp?.id ?? null;
  const appId = foreground?.startsWith(SYSTEM_APP_PREFIX) ? null : foreground;
  const { listKeychainKeys, setKeychainValues, deleteKeychainValues } = client ?? {};
  const available =
    client?.capabilities.keychain === true &&
    !!listKeychainKeys &&
    !!setKeychainValues &&
    !!deleteKeychainValues;
  // @ref LLP 0000#steady-inspector — preserve the section layout during reconnects.
  const [seenCapability, setSeenCapability] = useState(available);
  if (available && !seenCapability) setSeenCapability(true);
  const reconnecting =
    seenCapability &&
    (!client ||
      client.status === "idle" ||
      client.status === "connecting" ||
      client.status === "reconnecting");
  const [formApp, setFormApp] = useState(appId);
  const activeFormApp = useRef(formApp);
  useEffect(() => {
    activeFormApp.current = formApp;
  }, [formApp]);

  // @ref LLP 0020#hub-ui — keep a draft through a relaunch and clear it for another app.
  if (appId !== null && appId !== formApp) {
    setFormApp(appId);
    setKey("");
    setValue("");
    setFormat("expo-secure-store");
    setFieldValue("");
    setFieldPasteRejected(false);
    setKeyPasteRejected(false);
    setQuery({ format: "expo-secure-store" });
    setKeys(null);
    setListError(null);
    setNote(null);
    setError(null);
  }

  const missing = missingKeychainField(query);
  const shown = KEYCHAIN_FORMAT_UI[format];
  const usesService = shown.field.option === "service";
  const fieldLabel = shown.field.label.toLowerCase();
  const serviceChanged = usesService && fieldValue !== (query.service ?? "");
  const setDisabled = pending !== null || fieldPasteRejected || keyPasteRejected;
  const deleteDisabled = pending !== null || serviceChanged || (usesService && fieldPasteRejected);
  const requiredFieldError = `Enter the ${fieldLabel}.`;

  useEffect(() => {
    setKeys(null);
    setListError(null);
    if (!available || !open || !appId || !listKeychainKeys || missingKeychainField(query)) return;
    let current = true;
    listKeychainKeys(appId, query).then(
      (next) => current && setKeys(next),
      (reason: unknown) => current && setListError(errorMessage(reason)),
    );
    return () => {
      current = false;
    };
  }, [available, open, appId, query, listKeychainKeys]);

  const listOptions = (): KeychainOptions => ({
    format,
    ...(usesService && fieldValue ? { service: fieldValue } : {}),
  });
  function listWith(options: KeychainOptions) {
    setKeys(null);
    setListError(null);
    setQuery({ ...options });
  }

  function listFromInput() {
    if (usesService && !fieldPasteRejected) listWith(listOptions());
  }

  // The app ID is fixed when the write starts: a relaunch moves the foreground away and back.
  async function write(
    kind: "set" | "delete",
    status: string,
    relaunch: boolean,
    options: KeychainOptions,
    run: (target: string) => Promise<KeychainWriteResult>,
  ) {
    if (!appId || pending) return;
    const target = appId;
    setPending(`${target}: ${status}`);
    setNote(null);
    setError(null);
    try {
      const result = await run(target);
      const outcome = describeKeychainWrite(kind, result, relaunch, target);
      setNote(outcome.note);
      setError(outcome.error ? `${target}: ${outcome.error}` : null);
      if (result.applied && activeFormApp.current === target) {
        if (kind === "set" && !outcome.error) {
          setKey("");
          setValue("");
        }
        listWith(options);
      }
    } catch (reason) {
      setError(`${target}: ${errorMessage(reason)}`);
    } finally {
      setPending(null);
    }
  }

  function refuse(message: string) {
    setNote(null);
    setError(message);
  }

  function set(relaunch: boolean) {
    if (!setKeychainValues || setDisabled) return;
    const options = listOptions();
    if (missingKeychainField(options)) return refuse(requiredFieldError);
    const draft = parseKeychainDraft(key, value);
    if (!draft.ok) return refuse(draft.error);
    void write(
      "set",
      relaunch ? "Setting and restarting the app…" : "Setting…",
      relaunch,
      options,
      (target) =>
        setKeychainValues(target, draft.values, {
          ...options,
          ...(!usesService && fieldValue ? { username: fieldValue } : {}),
          relaunch,
        }),
    );
  }

  function remove(name: string) {
    if (!deleteKeychainValues || deleteDisabled) return;
    void write("delete", `Deleting ${displayKeychainIdentifier(name)}…`, false, query, (target) =>
      deleteKeychainValues(target, [name], query),
    );
  }

  if (!available && !reconnecting) return null;

  return (
    <CollapsibleSection title="Keychain" open={open} onOpenChange={setOpen}>
      {!available ? (
        <SectionNote>Waiting for Keychain access while the device reconnects.</SectionNote>
      ) : appId === null ? (
        <SectionNote>
          {foreground === null || foreground === HOME_SCREEN
            ? "No app is in the foreground."
            : `${foreground} is a system app. Keychain works in user apps only.`}
        </SectionNote>
      ) : (
        <>
          <SidebarRow label="Format">
            <Select
              ariaLabel="Keychain format"
              value={format}
              options={KEYCHAIN_FORMAT_OPTIONS}
              width={188}
              disabled={pending !== null}
              onChange={(next) => {
                // The field can mean something else in the new format, so it starts empty, and a
                // note about a write in the old format goes.
                setFormat(next);
                setFieldValue("");
                setFieldPasteRejected(false);
                listWith({ format: next });
                setNote(null);
                setError(null);
              }}
            />
          </SidebarRow>
          <SidebarRow label={shown.field.label} description={shown.field.description}>
            <SidebarTextInput
              ariaLabel={`Keychain ${fieldLabel}`}
              inputMode="text"
              placeholder={shown.field.placeholder}
              value={fieldValue}
              disabled={pending !== null}
              invalid={fieldPasteRejected}
              onChange={(next) => {
                setFieldValue(next);
                setFieldPasteRejected(false);
                if (next && error === requiredFieldError) setError(null);
              }}
              onPasteText={(text) => rejectMultilinePaste(text, setFieldPasteRejected)}
              onSubmit={listFromInput}
            />
          </SidebarRow>
          {fieldPasteRejected && (
            <SectionNote role="alert">{`Enter a ${fieldLabel} on one line.`}</SectionNote>
          )}
          {usesService && !missing && (
            <SectionNote>{`Keys for service ${displayKeychainIdentifier(query.service ?? "app")}.`}</SectionNote>
          )}
          {shown.note && <SectionNote>{shown.note}</SectionNote>}
          {missing ? (
            <SectionNote>{`Enter the ${missing}, then choose List keys or press Enter.`}</SectionNote>
          ) : keys === null ? (
            listError ? (
              <>
                <SectionNote role="alert">{listError}</SectionNote>
                <div style={GROUP_STYLE}>
                  <Button theme="secondary" size="xs" onClick={() => listWith(query)}>
                    Retry
                  </Button>
                </div>
              </>
            ) : (
              <SectionNote>Reading keys…</SectionNote>
            )
          ) : keys.length === 0 ? (
            <SectionNote>
              {KEYCHAIN_FORMAT_UI[query.format ?? "expo-secure-store"].empty}
            </SectionNote>
          ) : (
            keys.map((name) => {
              const label = displayKeychainIdentifier(name);
              return (
                <SidebarRow key={name} label={label}>
                  <Button
                    theme="tertiary"
                    size="xs"
                    aria-label={`Delete ${label}`}
                    disabled={deleteDisabled}
                    onClick={() => remove(name)}
                  >
                    Delete
                  </Button>
                </SidebarRow>
              );
            })
          )}
          <SidebarRow label="Key">
            <SidebarTextInput
              ariaLabel="Keychain key"
              inputMode="text"
              placeholder={shown.keyPlaceholder ?? "accessToken"}
              value={key}
              disabled={pending !== null}
              invalid={keyPasteRejected}
              onChange={(next) => {
                setKey(next);
                setKeyPasteRejected(false);
              }}
              onPasteText={(text) => rejectMultilinePaste(text, setKeyPasteRejected)}
              onSubmit={() => set(false)}
            />
          </SidebarRow>
          {keyPasteRejected && <SectionNote role="alert">Enter a key on one line.</SectionNote>}
          <div style={GROUP_STYLE}>
            <SidebarTextArea
              ariaLabel="Keychain value"
              placeholder="Value, or a JSON object of keys and values"
              value={value}
              disabled={pending !== null}
              onChange={setValue}
              onSubmit={() => set(false)}
            />
          </div>
          <div style={BUTTONS_STYLE}>
            {serviceChanged && (
              <Button
                theme="tertiary"
                size="xs"
                disabled={pending !== null || fieldPasteRejected}
                onClick={listFromInput}
              >
                List keys
              </Button>
            )}
            <Button theme="secondary" size="xs" disabled={setDisabled} onClick={() => set(false)}>
              Set
            </Button>
            <Button theme="tertiary" size="xs" disabled={setDisabled} onClick={() => set(true)}>
              Set and relaunch
            </Button>
          </div>
          <SectionNote>Values are never read back from the app.</SectionNote>
        </>
      )}
      {/* Outside the form: a relaunch passes through the home screen before its result. */}
      {pending && <SectionNote role="status">{pending}</SectionNote>}
      {note && <SectionNote role="status">{note}</SectionNote>}
      {error && <SectionNote role="alert">{error}</SectionNote>}
    </CollapsibleSection>
  );
}
