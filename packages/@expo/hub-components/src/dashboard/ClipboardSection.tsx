import { forwardRef, useEffect, useRef, useState } from 'react';

import { type DeviceClient, type DeviceClipboardAction } from '@expo/hub-client';
import { Button, bg, border, font, isFocusVisible, radius, text, textSize } from '../primitives';
import { copyFieldSelection, errorMessage, writeBrowserClipboard } from './browserClipboard';
import { CLIPBOARD_TEXT, type ClipboardRequest, HARDWARE_KEYBOARD_NOTE } from './ClipboardToast';
import { CollapsibleSection, SECTION_TRANSITION_MS } from './CollapsibleSection';
import { SectionNote } from './SectionNote';

/**
 * Show the text that the device app copies, and paste typed text into the app, in the order of
 * serve-sim's Clipboard menu. It needs no
 * browser clipboard access, so it finishes a toolbar Paste or Copy that the browser stopped.
 */
export function ClipboardSection({
  client,
  defaultOpen = false,
  request = null,
  onRequestHandled,
}: {
  client: DeviceClient;
  /** Whether the section is initially expanded. */
  defaultOpen?: boolean;
  /** A toolbar action that the browser clipboard stopped. The section opens and takes it over. */
  request?: ClipboardRequest | null;
  onRequestHandled?: () => void;
}) {
  const [open, setOpen] = useState(defaultOpen);
  const [draft, setDraft] = useState('');
  const [copied, setCopied] = useState<string | null>(null);
  // Each action of the section has its own state, so a Copy during a Paste keeps Send disabled.
  const [pasting, setPasting] = useState(false);
  const [copying, setCopying] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [copyNote, setCopyNote] = useState<string | null>(null);
  const [focusField, setFocusField] = useState<DeviceClipboardAction | null>(null);
  const pasteField = useRef<HTMLTextAreaElement>(null);
  const copiedField = useRef<HTMLTextAreaElement>(null);

  useEffect(() => {
    if (!request) return;
    setOpen(true);
    if (request.action === 'copy') {
      setCopied(request.text);
      setCopyNote(null);
    }
    setFocusField(request.action);
    onRequestHandled?.();
  }, [request, onRequestHandled]);

  // The fields mount when the section opens, so focus waits for them. The scroll waits until the
  // section has expanded; earlier, the sidebar cannot scroll far enough to keep the field clear of
  // the toast in the corner.
  useEffect(() => {
    if (!open || !focusField) return;
    const field = focusField === 'paste' ? pasteField.current : copiedField.current;
    if (!field) return;
    setFocusField(null);
    field.focus({ preventScroll: true });
    if (focusField === 'copy') field.select();
    window.setTimeout(() => field.scrollIntoView({ block: 'center' }), SECTION_TRANSITION_MS);
  }, [open, focusField]);

  const capabilities = client.capabilities.clipboard;
  if (!capabilities || !(capabilities.paste || capabilities.copy)) return null;

  async function paste() {
    const value = draft;
    setPasting(true);
    setError(null);
    try {
      await client.pasteText(value);
      setDraft((current) => (current === value ? '' : current));
    } catch (reason) {
      setError(errorMessage(reason));
    } finally {
      setPasting(false);
    }
  }

  async function copy() {
    setCopying(true);
    setError(null);
    setCopyNote(null);
    try {
      setCopied(await client.copyText());
    } catch (reason) {
      setError(errorMessage(reason));
    } finally {
      setCopying(false);
    }
  }

  async function copyToBrowser() {
    if (!copied) return;
    try {
      await writeBrowserClipboard(copied);
      setCopyNote(CLIPBOARD_TEXT.copied);
      return;
    } catch {
      // As serve-sim's copy fallback, try the selection copy before asking for Command+C.
    }
    // The field keeps the selection, so Command+C still copies it.
    if (copyFieldSelection(copiedField.current)) {
      setCopyNote(CLIPBOARD_TEXT.copied);
      return;
    }
    setCopyNote(`${CLIPBOARD_TEXT.copyFailed}. Press Command+C or Ctrl+C to copy the selected text`);
  }

  return (
    <CollapsibleSection title="Clipboard" open={open} onOpenChange={setOpen}>
      {capabilities.copy && (
        <div style={GROUP_STYLE}>
          <Button theme="secondary" size="xs" disabled={copying} onClick={() => void copy()}>
            Copy from Simulator
          </Button>
          {copied !== null && (
            <>
              <ClipboardTextField ref={copiedField} ariaLabel="Copied text" value={copied} readOnly />
              <Button theme="tertiary" size="xs" disabled={!copied} onClick={() => void copyToBrowser()}>
                Copy
              </Button>
            </>
          )}
        </div>
      )}
      {capabilities.paste && (
        <div style={GROUP_STYLE}>
          <ClipboardTextField
            ref={pasteField}
            ariaLabel="Text to paste into the simulator"
            placeholder={CLIPBOARD_TEXT.pasteHere}
            value={draft}
            onChange={setDraft}
            onSubmit={() => {
              if (draft && !pasting) void paste();
            }}
          />
          <Button
            theme="secondary"
            size="xs"
            disabled={!draft || pasting}
            onClick={() => void paste()}>
            Send
          </Button>
        </div>
      )}
      {copying && <SectionNote role="status">{CLIPBOARD_TEXT.copying}</SectionNote>}
      {pasting && <SectionNote role="status">{CLIPBOARD_TEXT.pasting}</SectionNote>}
      {error && <SectionNote role="alert">{error}</SectionNote>}
      {copied === '' && <SectionNote>{CLIPBOARD_TEXT.simulatorEmpty}</SectionNote>}
      {copyNote && <SectionNote role="status">{copyNote}</SectionNote>}
      {client.hardwareKeyboardConnected === false && (
        <SectionNote>{HARDWARE_KEYBOARD_NOTE}</SectionNote>
      )}
    </CollapsibleSection>
  );
}

const GROUP_STYLE = {
  display: 'flex',
  flexDirection: 'column',
  alignItems: 'flex-start',
  gap: 8,
  padding: '4px 0 12px',
} as const;

const ClipboardTextField = forwardRef<
  HTMLTextAreaElement,
  {
    ariaLabel: string;
    placeholder?: string;
    value: string;
    readOnly?: boolean;
    onChange?: (value: string) => void;
    /** Command+Enter or Control+Enter in the field. */
    onSubmit?: () => void;
  }
>(function ClipboardTextField(
  { ariaLabel, placeholder, value, readOnly = false, onChange, onSubmit },
  ref,
) {
  const [focused, setFocused] = useState(false);

  return (
    <textarea
      ref={ref}
      aria-label={ariaLabel}
      placeholder={placeholder}
      value={value}
      readOnly={readOnly}
      rows={3}
      autoComplete="off"
      spellCheck={false}
      onChange={(event) => onChange?.(event.currentTarget.value)}
      onFocus={(event) => setFocused(isFocusVisible(event))}
      onBlur={() => setFocused(false)}
      onKeyDown={(event) => {
        if (event.key === 'Enter' && (event.metaKey || event.ctrlKey)) onSubmit?.();
      }}
      style={{
        ...textSize.sm,
        display: 'block',
        width: '100%',
        boxSizing: 'border-box',
        padding: '6px 10px',
        border: `1px solid ${border.default}`,
        borderRadius: radius.lg,
        outline: 'none',
        backgroundColor: bg.element,
        boxShadow: focused ? `0 0 0 2px ${border.secondary}` : 'none',
        color: text.default,
        caretColor: text.default,
        fontFamily: font.mono,
        resize: 'vertical',
      }}
    />
  );
});
