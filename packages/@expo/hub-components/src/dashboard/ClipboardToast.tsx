import { useCallback, useEffect, useLayoutEffect, useRef } from 'react';
import { toast as sonnerToast } from 'sonner';

import { type DeviceClient, type DeviceClipboardAction } from '@expo/hub-client';
import { ClipboardPasteIcon, CopyIcon, bg, icon, radius, text, textSize } from '../primitives';
import { errorMessage, readBrowserClipboard, writeBrowserClipboard } from './browserClipboard';
import { DEVICE_TOASTER_ID, TOAST_PILL_STYLE } from './ScreenshotToast';

/**
 * What a clipboard toast says, with serve-sim's statuses. The action picks its icon. serve-sim's
 * `paste` status (a paste field in the toast) is `info` here, because the field is in the
 * inspector's Clipboard section.
 */
export type ClipboardToastState = {
  action: DeviceClipboardAction;
  status: 'pending' | 'success' | 'info' | 'manual' | 'error';
  message: string;
};

/**
 * A toolbar Paste or Copy that the browser clipboard stopped, for the inspector's Clipboard
 * section to finish.
 */
export type ClipboardRequest = { action: 'paste' } | { action: 'copy'; text: string };

/** serve-sim presses Command+V and Command+C, which iOS ignores without the hardware keyboard. */
export const HARDWARE_KEYBOARD_NOTE =
  'Paste and Copy need the hardware keyboard. Turn it on in Device options.';

/**
 * The texts of serve-sim's preview, for the toasts and the Clipboard section. serve-sim has a paste
 * field and a Copy button in its toast; the two `InSection` texts point to the section instead.
 */
export const CLIPBOARD_TEXT = {
  pasting: 'Pasting into the simulator…',
  pasted: 'Pasted into simulator',
  pasteFailed: 'Could not write to the simulator clipboard',
  pasteHere: 'Paste here to send it to the simulator',
  pasteInSection: 'Paste in the Clipboard section to send it to the simulator',
  deviceEmpty: 'Device clipboard is empty',
  copying: 'Reading simulator clipboard…',
  copied: 'Copied from simulator',
  copyFailed: 'Copy failed',
  copyInSection: 'Ready — one click to copy in the Clipboard section',
  simulatorEmpty: 'Simulator clipboard is empty',
  simulatorEmptyNotWritten: 'Simulator clipboard is empty. The browser clipboard still has older text',
} as const;

// A result shows for 3 s, as in serve-sim. serve-sim shows its manual toast for 12 s and keeps its
// paste-field toast until the user acts. Here the `info` toast, which points to the paste field in
// the Clipboard section, also shows for 12 s.
const DISMISS_MS = 3000;
const MANUAL_DISMISS_MS = 12_000;

const TOAST_IDS: Record<DeviceClipboardAction, string> = {
  paste: 'hub-clipboard-paste',
  copy: 'hub-clipboard-copy',
};
const WARNING_TOAST_ID = 'hub-clipboard-warning';

const PENDING: Record<DeviceClipboardAction, ClipboardToastState> = {
  paste: { action: 'paste', status: 'pending', message: CLIPBOARD_TEXT.pasting },
  copy: { action: 'copy', status: 'pending', message: CLIPBOARD_TEXT.copying },
};

function show(id: string, toast: ClipboardToastState, duration: number) {
  sonnerToast.custom(() => <ClipboardToast toast={toast} />, {
    id,
    toasterId: DEVICE_TOASTER_ID,
    duration,
  });
}

function showResult(toast: ClipboardToastState) {
  show(
    TOAST_IDS[toast.action],
    toast,
    toast.status === 'info' || toast.status === 'manual' ? MANUAL_DISMISS_MS : DISMISS_MS,
  );
}

/** The error of a Paste or Copy in the device, with serve-sim's text when the error has none. */
export function clipboardErrorToast(action: DeviceClipboardAction, error: string): ClipboardToastState {
  return {
    action,
    status: 'error',
    message: error || (action === 'paste' ? CLIPBOARD_TEXT.pasteFailed : CLIPBOARD_TEXT.copyFailed),
  };
}

type Claim = { action: DeviceClipboardAction; started: boolean };

/**
 * The toolbar's Copy from Simulator and Paste from Device, a `pasteText` for `DeviceScreen`, and the
 * clipboard toasts of the device. Each of these reports its result from its own call, because only
 * the call knows the browser clipboard step and keeps its result when a newer action replaces the
 * client's fields. Give `pasteText` to `DeviceScreen`: a Command+V paste with text then shows
 * in flight and done, and a Command+V without text (the device pastes its own clipboard) shows only
 * its error, as in serve-sim. An action of another caller, such as the inspector's Clipboard
 * section, shows its own result; from the fields this hook shows only the key warning.
 */
export function useClipboardToast(
  client: DeviceClient,
  deviceId: string,
  onFallback?: (request: ClipboardRequest) => void,
) {
  const latest = useRef({ client, onFallback });
  latest.current = { client, onFallback };
  // @ref LLP 0013#dashboard — the latest Paste wins over one that still reads the browser clipboard
  const pasteGeneration = useRef(0);
  const copyGeneration = useRef(0);
  // An action of this hook that the fields do not show yet. `started` is set when they show it.
  const claim = useRef<Claim | null>(null);
  const {
    clipboardActionId: actionId,
    clipboardPending: pending,
    clipboardWarning: warning,
  } = client;
  const observed = useRef<{
    actionId: number;
    pending: DeviceClipboardAction | null;
    startedFor: string | null;
  }>({ actionId, pending: null, startedFor: null });

  // A layout effect sees a change in the same commit, so a claim is marked started before the
  // call's own continuation can run.
  useLayoutEffect(() => {
    const previous = observed.current;
    if (actionId !== previous.actionId) {
      observed.current = { actionId, pending, startedFor: deviceId };
      const owned = claim.current;
      if (owned && !owned.started && (pending === null || owned.action === pending)) {
        owned.started = true;
      } else if (pending === 'paste') {
        // Every new Paste is a new action, also while an older Paste is in flight. As serve-sim's
        // Command+V, it cancels a toolbar Paste and removes its toast.
        pasteGeneration.current++;
        sonnerToast.dismiss(TOAST_IDS.paste);
      }
      return;
    }
    observed.current = { actionId, pending, startedFor: previous.startedFor };
    // The fields of a previous device can still end after the switch.
    if (pending || !previous.pending || previous.startedFor !== deviceId) return;
    // serve-sim shows a key that it could not release as an error toast of its own.
    if (warning) {
      show(WARNING_TOAST_ID, { action: previous.pending, status: 'error', message: warning }, DISMISS_MS);
    }
  }, [deviceId, actionId, pending, warning]);

  useEffect(
    () => () => {
      pasteGeneration.current++;
      copyGeneration.current++;
      claim.current = null;
      sonnerToast.dismiss(TOAST_IDS.paste);
      sonnerToast.dismiss(TOAST_IDS.copy);
      sonnerToast.dismiss(WARNING_TOAST_ID);
    },
    [deviceId],
  );

  const run = useCallback(async <T,>(action: DeviceClipboardAction, call: () => Promise<T>) => {
    const owned: Claim = { action, started: false };
    claim.current = owned;
    try {
      return await call();
    } finally {
      if (claim.current === owned) claim.current = null;
    }
  }, []);

  // As serve-sim's `pasteTextForGeneration`. Without text the device pastes its own clipboard,
  // and only an error shows, as for serve-sim's Command+V fallback.
  const pasteForGeneration = useCallback(
    async (value: string | undefined, generation: number) => {
      const current = () => generation === pasteGeneration.current;
      if (!current()) return;
      if (value) show(TOAST_IDS.paste, PENDING.paste, Infinity);
      else sonnerToast.dismiss(TOAST_IDS.paste);
      const target = latest.current.client;
      try {
        await run('paste', () => target.pasteText(value));
      } catch (reason) {
        if (current()) showResult(clipboardErrorToast('paste', errorMessage(reason)));
        throw reason;
      }
      if (value && current()) {
        showResult({ action: 'paste', status: 'success', message: CLIPBOARD_TEXT.pasted });
      }
    },
    [run],
  );

  /** `pasteText` for `DeviceScreen`, whose Command+V then reports like serve-sim's. */
  const pasteText = useCallback(
    (value?: string) => pasteForGeneration(value, ++pasteGeneration.current),
    [pasteForGeneration],
  );

  const pasteFromDevice = useCallback(async () => {
    const generation = ++pasteGeneration.current;
    const current = () => generation === pasteGeneration.current;
    let value: string;
    try {
      value = await readBrowserClipboard();
    } catch {
      if (!current()) return;
      showResult({
        action: 'paste',
        status: 'info',
        message: CLIPBOARD_TEXT.pasteInSection,
      });
      latest.current.onFallback?.({ action: 'paste' });
      return;
    }
    if (!current()) return;
    if (!value) {
      showResult({ action: 'paste', status: 'success', message: CLIPBOARD_TEXT.deviceEmpty });
      return;
    }
    // As in serve-sim, the Paste shows in flight once the browser clipboard is read.
    await pasteForGeneration(value, generation).catch(() => {});
  }, [pasteForGeneration]);

  const copyFromSimulator = useCallback(async () => {
    const generation = ++copyGeneration.current;
    const current = () => generation === copyGeneration.current;
    show(TOAST_IDS.copy, PENDING.copy, Infinity);
    const target = latest.current.client;
    let value: string;
    try {
      value = await run('copy', () => target.copyText());
    } catch (reason) {
      if (current()) showResult(clipboardErrorToast('copy', errorMessage(reason)));
      return;
    }
    if (!current()) return;
    try {
      await writeBrowserClipboard(value);
    } catch {
      if (!current()) return;
      if (!value) {
        showResult({ action: 'copy', status: 'error', message: CLIPBOARD_TEXT.simulatorEmptyNotWritten });
        return;
      }
      // serve-sim offers a one-click Copy in the toast; here the Clipboard section has it.
      showResult({ action: 'copy', status: 'manual', message: CLIPBOARD_TEXT.copyInSection });
      latest.current.onFallback?.({ action: 'copy', text: value });
      return;
    }
    if (!current()) return;
    showResult({
      action: 'copy',
      status: 'success',
      message: value ? CLIPBOARD_TEXT.copied : CLIPBOARD_TEXT.simulatorEmpty,
    });
  }, [run]);

  return { pasteFromDevice, copyFromSimulator, pasteText };
}

// serve-sim's status dot colors: blue while in flight or for a next step, green for a result,
// amber when the user must finish, red for an error.
const STATUS_ICON_COLOR: Record<ClipboardToastState['status'], string> = {
  pending: icon.info,
  info: icon.info,
  success: icon.success,
  manual: icon.warning,
  error: icon.danger,
};

/** The pill that reports one clipboard action: its icon in the status color, and its message. */
export function ClipboardToast({ toast }: { toast: ClipboardToastState }) {
  const Icon = toast.action === 'paste' ? ClipboardPasteIcon : CopyIcon;
  return (
    <div data-testid="clipboard-toast" data-status={toast.status} style={TOAST_PILL_STYLE}>
      <span
        style={{
          width: 36,
          height: 36,
          flexShrink: 0,
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'center',
          borderRadius: radius.md,
          backgroundColor: bg.element,
          color: STATUS_ICON_COLOR[toast.status],
        }}>
        <Icon size={18} />
      </span>
      <span
        style={{
          ...textSize.sm,
          minWidth: 0,
          lineHeight: 1.3,
          fontWeight: 600,
          overflowWrap: 'anywhere',
          color: toast.status === 'error' ? text.danger : text.default,
        }}>
        {toast.message}
      </span>
    </div>
  );
}
