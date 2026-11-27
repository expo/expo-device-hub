import { useEffect, useRef, useState } from "react";

import {
  type DeviceClient,
  type KeychainOptions,
  type KeychainWriteResult,
} from "@expo/hub-client";
import { Button } from "../primitives";
import { errorMessage } from "./browserClipboard";
import { CollapsibleSection } from "./CollapsibleSection";
import { describeKeychainWrite, parseKeychainDraft } from "./keychainInput";
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

/**
 * Keychain values of the foreground app, in expo-secure-store's layout: list its keys, set
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
  const [service, setService] = useState("");
  // The options the keys are listed with, so a Delete goes where they were read. Typing a service
  // does not change it; Enter in the field or a Set does. A new object lists the keys again.
  const [query, setQuery] = useState<KeychainOptions>({});
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
    (!client || client.status === "connecting" || client.status === "reconnecting");
  const serviceChanged = service !== (query.service ?? "");
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
    setService("");
    setQuery({});
    setKeys(null);
    setListError(null);
    setNote(null);
    setError(null);
  }

  useEffect(() => {
    setKeys(null);
    setListError(null);
    if (!available || !open || !appId || !listKeychainKeys) return;
    let current = true;
    listKeychainKeys(appId, query).then(
      (next) => current && setKeys(next),
      (reason: unknown) => current && setListError(errorMessage(reason)),
    );
    return () => {
      current = false;
    };
  }, [available, open, appId, query, listKeychainKeys]);

  const typedOptions = (): KeychainOptions => (service ? { service } : {});
  function listWith(options: KeychainOptions) {
    setKeys(null);
    setListError(null);
    setQuery({ ...options });
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

  function set(relaunch: boolean) {
    if (!setKeychainValues) return;
    const draft = parseKeychainDraft(key, value);
    if (!draft.ok) {
      setNote(null);
      setError(draft.error);
      return;
    }
    const options = typedOptions();
    void write(
      "set",
      relaunch ? "Setting and restarting the app…" : "Setting…",
      relaunch,
      options,
      (target) => setKeychainValues(target, draft.values, { ...options, relaunch }),
    );
  }

  function remove(name: string) {
    if (!deleteKeychainValues || serviceChanged) return;
    void write("delete", `Deleting ${name}…`, false, query, (target) =>
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
          <SectionNote>{`Keys for service ${query.service ?? "app"}.`}</SectionNote>
          {keys === null ? (
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
            <SectionNote>This app stored no SecureStore values.</SectionNote>
          ) : (
            keys.map((name) => (
              <SidebarRow key={name} label={name}>
                <Button
                  theme="tertiary"
                  size="xs"
                  aria-label={`Delete ${name}`}
                  disabled={pending !== null || serviceChanged}
                  onClick={() => remove(name)}
                >
                  Delete
                </Button>
              </SidebarRow>
            ))
          )}
          <SidebarRow label="Key">
            <SidebarTextInput
              ariaLabel="Keychain key"
              inputMode="text"
              placeholder="accessToken"
              value={key}
              disabled={pending !== null}
              onChange={setKey}
              onSubmit={() => set(false)}
            />
          </SidebarRow>
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
          <SidebarRow label="Service" description="SecureStore keychainService">
            <SidebarTextInput
              ariaLabel="Keychain service"
              inputMode="text"
              placeholder="app"
              value={service}
              disabled={pending !== null}
              onChange={setService}
              onSubmit={() => listWith(typedOptions())}
            />
          </SidebarRow>
          <div style={BUTTONS_STYLE}>
            {serviceChanged && (
              <Button
                theme="tertiary"
                size="xs"
                disabled={pending !== null}
                onClick={() => listWith(typedOptions())}
              >
                List keys
              </Button>
            )}
            <Button
              theme="secondary"
              size="xs"
              disabled={pending !== null}
              onClick={() => set(false)}
            >
              Set
            </Button>
            <Button
              theme="tertiary"
              size="xs"
              disabled={pending !== null}
              onClick={() => set(true)}
            >
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
