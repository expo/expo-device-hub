import { afterEach, beforeEach, expect, spyOn, test } from 'bun:test';
import { type ReactElement, useEffect, useRef, useState } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { act, create, type ReactTestRenderer } from 'react-test-renderer';
import { toast } from 'sonner';

import { type DeviceClient, type DeviceClipboardAction } from '@expo/hub-client';
import {
  ClipboardToast,
  type ClipboardRequest,
  type ClipboardToastState,
  useClipboardToast,
} from '../dashboard/ClipboardToast';
import { createGlobalStubs } from './test-globals';

const { stubGlobal, restoreGlobals } = createGlobalStubs();

type Shown = { id: string; duration: number | undefined; toast: ClipboardToastState };
type Call = {
  action: DeviceClipboardAction;
  text?: string;
  resolve: (value?: string, warning?: string) => void;
  reject: (message: string) => void;
};

const KEY_WARNING = 'A simulator key may still be held. Release it or reconnect input.';

let shown: Shown[] = [];
let dismissed: Array<string | number | undefined> = [];
let calls: Call[] = [];
let fallbacks: ClipboardRequest[] = [];
let written: string[] = [];
let client: DeviceClient;
let actions: ReturnType<typeof useClipboardToast>;
let renderer: ReactTestRenderer | undefined;
let spies: Array<{ mockRestore: () => void }> = [];

beforeEach(() => {
  shown = [];
  dismissed = [];
  calls = [];
  fallbacks = [];
  written = [];
  stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
  spies = [
    spyOn(toast, 'custom').mockImplementation((jsx, data) => {
      const id = data!.id!;
      const element = jsx(id) as ReactElement<{ toast: ClipboardToastState }>;
      shown.push({ id: String(id), duration: data?.duration, toast: element.props.toast });
      return id;
    }),
    spyOn(toast, 'dismiss').mockImplementation((id) => {
      dismissed.push(id);
      return id!;
    }),
  ];
});

afterEach(async () => {
  if (renderer) await act(async () => renderer?.unmount());
  renderer = undefined;
  for (const spy of spies) spy.mockRestore();
  restoreGlobals();
});

const IDLE = { clipboardPending: null, clipboardError: null, clipboardWarning: null };
const PASTING: Shown = {
  id: 'hub-clipboard-paste',
  duration: Infinity,
  toast: { action: 'paste', status: 'pending', message: 'Pasting into the simulator…' },
};
const PASTED: Shown = {
  id: 'hub-clipboard-paste',
  duration: 3000,
  toast: { action: 'paste', status: 'success', message: 'Pasted into simulator' },
};

/** The clipboard half of a client, settled like HubClient: fields follow the latest action only. */
function useFakeClient(deviceId: string, hardwareKeyboardConnected: boolean | null) {
  const [fields, setFields] = useState<{
    clipboardPending: DeviceClipboardAction | null;
    clipboardError: string | null;
    clipboardWarning: string | null;
  }>(IDLE);
  const generation = useRef(0);
  const [actionId, setActionId] = useState(0);

  // A device change fails the requests of the old device without showing their result.
  useEffect(() => {
    generation.current++;
    setFields(IDLE);
  }, [deviceId]);

  function run(action: DeviceClipboardAction, text?: string) {
    const current = ++generation.current;
    setActionId((id) => id + 1);
    setFields({ clipboardPending: action, clipboardError: null, clipboardWarning: null });
    return new Promise<string | undefined>((resolve, reject) => {
      calls.push({
        action,
        text,
        resolve: (value, warning) => {
          if (current === generation.current) {
            setFields({ clipboardPending: null, clipboardError: null, clipboardWarning: warning ?? null });
          }
          resolve(value);
        },
        reject: (message) => {
          if (current === generation.current) {
            setFields({ clipboardPending: null, clipboardError: message, clipboardWarning: null });
          }
          reject(new Error(message));
        },
      });
    });
  }

  return {
    ...fields,
    clipboardActionId: actionId,
    hardwareKeyboardConnected,
    pasteText: async (text?: string) => {
      await run('paste', text);
    },
    copyText: async () => (await run('copy')) ?? '',
  } as unknown as DeviceClient;
}

function Harness({ deviceId, keyboard }: { deviceId: string; keyboard: boolean | null }) {
  client = useFakeClient(deviceId, keyboard);
  actions = useClipboardToast(client, deviceId, (request) => fallbacks.push(request));
  return null;
}

async function render(deviceId = 'sim-a', keyboard: boolean | null = true) {
  await act(async () => {
    if (renderer) renderer.update(<Harness deviceId={deviceId} keyboard={keyboard} />);
    else renderer = create(<Harness deviceId={deviceId} keyboard={keyboard} />);
  });
}

/** Run one user or device step and let its promises and renders finish. */
async function step(action?: () => void) {
  await act(async () => {
    action?.();
    await new Promise((resolve) => setTimeout(resolve, 0));
  });
}

function setBrowserClipboard(clipboard: Partial<Clipboard> | undefined) {
  stubGlobal('navigator', { clipboard });
}

function writableClipboard(readText?: () => Promise<string>): Partial<Clipboard> {
  return {
    ...(readText ? { readText } : {}),
    writeText: async (text: string) => {
      written.push(text);
    },
  };
}

/** Finished results, without the in-flight toasts. */
function results() {
  return shown.filter((entry) => entry.duration !== Infinity);
}

/** A Command+V in `DeviceScreen`, which gets the hook's `pasteText`. */
function deviceScreenPaste(text?: string) {
  actions.pasteText(text).catch(() => {});
}

/** A Paste of another caller, such as the inspector's Clipboard section. */
function otherPaste(text: string) {
  client.pasteText(text).catch(() => {});
}

test('Paste sends the browser text and reports serve-sim\'s Pasted into simulator once', async () => {
  setBrowserClipboard(writableClipboard(async () => 'from the browser'));
  await render();

  await step(() => void actions.pasteFromDevice());
  expect(calls.map(({ action, text }) => ({ action, text }))).toEqual([
    { action: 'paste', text: 'from the browser' },
  ]);
  expect(shown.map((entry) => entry.toast)).toEqual([
    { action: 'paste', status: 'pending', message: 'Pasting into the simulator…' },
  ]);
  expect(results()).toEqual([]);

  await step(() => calls[0].resolve());
  expect(results()).toEqual([
    {
      id: 'hub-clipboard-paste',
      duration: 3000,
      toast: { action: 'paste', status: 'success', message: 'Pasted into simulator' },
    },
  ]);
});

test('a Paste that the browser denies points to the Clipboard section', async () => {
  setBrowserClipboard({
    readText: async () => {
      throw new DOMException('Read permission denied.', 'NotAllowedError');
    },
  });
  await render();

  await step(() => void actions.pasteFromDevice());
  expect(calls).toEqual([]);
  expect(fallbacks).toEqual([{ action: 'paste' }]);
  expect(shown).toEqual([
    {
      id: 'hub-clipboard-paste',
      duration: 12_000,
      toast: {
        action: 'paste',
        status: 'info',
        message: 'Paste in the Clipboard section to send it to the simulator',
      },
    },
  ]);
});

test('a browser without readText also points to the Clipboard section', async () => {
  for (const clipboard of [undefined, writableClipboard()]) {
    shown = [];
    fallbacks = [];
    setBrowserClipboard(clipboard);
    await render();
    await step(() => void actions.pasteFromDevice());
    expect(calls).toEqual([]);
    expect(fallbacks).toEqual([{ action: 'paste' }]);
    expect(results().map((entry) => entry.toast.message)).toEqual([
      'Paste in the Clipboard section to send it to the simulator',
    ]);
  }
});

test('an empty browser clipboard pastes nothing', async () => {
  setBrowserClipboard(writableClipboard(async () => ''));
  await render();

  await step(() => void actions.pasteFromDevice());
  expect(calls).toEqual([]);
  expect(results().map((entry) => entry.toast)).toEqual([
    { action: 'paste', status: 'success', message: 'Device clipboard is empty' },
  ]);
});

test('the latest Paste wins over one that still reads the browser clipboard', async () => {
  const reads: Array<(text: string) => void> = [];
  setBrowserClipboard({ readText: () => new Promise<string>((resolve) => reads.push(resolve)) });
  await render();

  await step(() => void actions.pasteFromDevice());
  await step(() => void actions.pasteFromDevice());
  await step(() => reads[0]('older'));
  expect(calls).toEqual([]);
  await step(() => reads[1]('newer'));
  expect(calls.map((call) => call.text)).toEqual(['newer']);

  await step(() => void actions.pasteFromDevice());
  await step(() => void actions.pasteFromDevice());
  await step(() => reads[3]('newest'));
  await step(() => reads[2]('stale'));
  expect(calls.map((call) => call.text)).toEqual(['newer', 'newest']);
});

test('a Command+V paste replaces a toolbar Paste that still reads the browser clipboard', async () => {
  const reads: Array<(text: string) => void> = [];
  setBrowserClipboard({ readText: () => new Promise<string>((resolve) => reads.push(resolve)) });
  await render();

  await step(() => void actions.pasteFromDevice());
  await step(() => deviceScreenPaste('typed'));
  await step(() => reads[0]('late'));
  expect(calls.map((call) => call.text)).toEqual(['typed']);
  expect(shown).toEqual([PASTING]);
});

test('a Command+V paste during a toolbar Paste in flight replaces its result and shows its own error', async () => {
  setBrowserClipboard(writableClipboard(async () => 'from the browser'));
  await render();

  await step(() => void actions.pasteFromDevice());
  await step(() => deviceScreenPaste());
  await step(() => calls[0].resolve());
  await step(() => calls[1].reject('Device input disconnected. Try again.'));
  expect(calls.map((call) => call.text)).toEqual(['from the browser', undefined]);
  expect(results().map((entry) => entry.toast)).toEqual([
    { action: 'paste', status: 'error', message: 'Device input disconnected. Try again.' },
  ]);
});

test('a Paste of another caller during a toolbar Paste in flight cancels the toolbar result', async () => {
  setBrowserClipboard(writableClipboard(async () => 'from the browser'));
  await render();

  await step(() => void actions.pasteFromDevice());
  dismissed = [];
  // The fields keep `clipboardPending` at paste; only `clipboardActionId` changes.
  await step(() => otherPaste('typed'));
  expect(dismissed).toEqual(['hub-clipboard-paste']);
  await step(() => calls[0].resolve());
  await step(() => calls[1].reject('Could not paste into the simulator'));
  // The other caller, the Clipboard section, shows its own error.
  expect(results()).toEqual([]);
});

test('a failed Paste or Copy of another caller shows no toast', async () => {
  setBrowserClipboard(writableClipboard());
  await render();

  await step(() => otherPaste('typed'));
  await step(() => calls[0].reject('Could not paste into the simulator'));
  await step(() => void client.copyText().catch(() => {}));
  await step(() => calls[1].reject('The app did not copy any new text.'));
  expect(shown).toEqual([]);
});

test('a failed toolbar Paste reports its error once', async () => {
  setBrowserClipboard(writableClipboard(async () => 'text'));
  await render();

  await step(() => void actions.pasteFromDevice());
  await step(() => calls[0].reject('Input is disconnected.'));
  expect(results().map((entry) => entry.toast)).toEqual([
    { action: 'paste', status: 'error', message: 'Input is disconnected.' },
  ]);
});

test('a Paste that fails before it renders in flight reports once and leaves no claim', async () => {
  setBrowserClipboard(writableClipboard(async () => 'text'));
  await render();

  // The client starts and fails the Paste in one render, as when input is disconnected.
  await act(async () => {
    void actions.pasteFromDevice();
    await new Promise((resolve) => setTimeout(resolve, 0));
    calls[0].reject('Input is disconnected.');
    await new Promise((resolve) => setTimeout(resolve, 0));
  });
  expect(results().map((entry) => entry.toast.message)).toEqual(['Input is disconnected.']);

  await step(() => deviceScreenPaste('typed'));
  await step(() => calls[1].reject('Paste timed out.'));
  expect(results().map((entry) => entry.toast.message)).toEqual([
    'Input is disconnected.',
    'Paste timed out.',
  ]);
});

test('Copy writes the app text to the browser clipboard and reports Copied from simulator once', async () => {
  setBrowserClipboard(writableClipboard());
  await render();

  await step(() => void actions.copyFromSimulator());
  expect(calls.map((call) => call.action)).toEqual(['copy']);
  expect(shown.map((entry) => entry.toast)).toEqual([
    { action: 'copy', status: 'pending', message: 'Reading simulator clipboard…' },
  ]);

  await step(() => calls[0].resolve('selected text'));
  expect(written).toEqual(['selected text']);
  expect(results()).toEqual([
    {
      id: 'hub-clipboard-copy',
      duration: 3000,
      toast: { action: 'copy', status: 'success', message: 'Copied from simulator' },
    },
  ]);
});

test('Copy of empty text clears the browser clipboard and says so', async () => {
  setBrowserClipboard(writableClipboard());
  await render();

  await step(() => void actions.copyFromSimulator());
  await step(() => calls[0].resolve(''));
  expect(written).toEqual(['']);
  expect(results().map((entry) => entry.toast)).toEqual([
    { action: 'copy', status: 'success', message: 'Simulator clipboard is empty' },
  ]);
});

test('Copy of empty text that the browser cannot write is an error', async () => {
  setBrowserClipboard({
    writeText: async () => {
      throw new DOMException('Document is not focused.', 'NotAllowedError');
    },
  });
  await render();

  await step(() => void actions.copyFromSimulator());
  await step(() => calls[0].resolve(''));
  expect(fallbacks).toEqual([]);
  expect(results().map((entry) => entry.toast)).toEqual([
    {
      action: 'copy',
      status: 'error',
      message: 'Simulator clipboard is empty. The browser clipboard still has older text',
    },
  ]);
});

test('a Copy that the browser cannot write hands the text to the Clipboard section', async () => {
  setBrowserClipboard({
    writeText: async () => {
      throw new DOMException('Document is not focused.', 'NotAllowedError');
    },
  });
  await render();

  await step(() => void actions.copyFromSimulator());
  await step(() => calls[0].resolve('selected text'));
  expect(fallbacks).toEqual([{ action: 'copy', text: 'selected text' }]);
  expect(results()).toEqual([
    {
      id: 'hub-clipboard-copy',
      duration: 12_000,
      toast: {
        action: 'copy',
        status: 'manual',
        message: 'Ready — one click to copy in the Clipboard section',
      },
    },
  ]);
});

test('a failed Copy reports its error once, as serve-sim does, also while the keyboard is off', async () => {
  setBrowserClipboard(writableClipboard());
  await render('sim-a', false);

  await step(() => void actions.copyFromSimulator());
  await step(() => calls[0].reject('The app did not copy any new text.'));
  expect(written).toEqual([]);
  expect(results().map((entry) => entry.toast)).toEqual([
    { action: 'copy', status: 'error', message: 'The app did not copy any new text.' },
  ]);
});

test('a Command+V paste with text shows in flight and done, as serve-sim\'s pasteText', async () => {
  setBrowserClipboard(writableClipboard());
  await render('sim-a', false);

  await step(() => deviceScreenPaste('typed'));
  expect(calls.map((call) => call.text)).toEqual(['typed']);
  expect(shown).toEqual([PASTING]);
  await step(() => calls[0].resolve());
  expect(results()).toEqual([PASTED]);
});

test('a Command+V paste without text shows only its error, as serve-sim\'s fallback', async () => {
  setBrowserClipboard(writableClipboard());
  await render('sim-a', false);

  await step(() => deviceScreenPaste());
  await step(() => calls[0].resolve());
  expect(shown).toEqual([]);

  // A paste that a replaced helper interrupted fails.
  await step(() => deviceScreenPaste());
  await step(() => calls[1].reject('Device input disconnected. Try again.'));
  expect(results()).toEqual([
    {
      id: 'hub-clipboard-paste',
      duration: 3000,
      toast: { action: 'paste', status: 'error', message: 'Device input disconnected. Try again.' },
    },
  ]);
});

test('shows a key warning as its own error toast, once per action, as serve-sim does', async () => {
  setBrowserClipboard(writableClipboard(async () => 'text'));
  await render();

  await step(() => otherPaste('typed'));
  await step(() => calls[0].resolve(undefined, KEY_WARNING));
  await step(() => void actions.pasteFromDevice());
  await step(() => calls[1].resolve(undefined, KEY_WARNING));

  const warning: Shown = {
    id: 'hub-clipboard-warning',
    duration: 3000,
    toast: { action: 'paste', status: 'error', message: KEY_WARNING },
  };
  expect(results()).toEqual([
    warning,
    // The toolbar Paste reports from its call, before the fields show the warning.
    PASTED,
    warning,
  ]);
});

test('keeps the result of a toolbar Copy that a newer Paste replaced in the fields', async () => {
  setBrowserClipboard(writableClipboard());
  await render();

  await step(() => void actions.copyFromSimulator());
  await step(() => otherPaste('typed'));
  await step(() => calls[0].resolve('selected text'));
  await step(() => calls[1].resolve());

  expect(written).toEqual(['selected text']);
  expect(results().map((entry) => [entry.id, entry.toast.message])).toEqual([
    ['hub-clipboard-copy', 'Copied from simulator'],
  ]);
});

test('a device change drops the old device results and its pending Paste', async () => {
  const reads: Array<(text: string) => void> = [];
  setBrowserClipboard({ readText: () => new Promise<string>((resolve) => reads.push(resolve)) });
  await render('sim-a');

  await step(() => deviceScreenPaste('typed'));
  await step(() => void actions.pasteFromDevice());
  dismissed = [];
  await render('sim-b');
  expect(dismissed).toEqual(['hub-clipboard-paste', 'hub-clipboard-copy', 'hub-clipboard-warning']);

  await step(() => reads[0]('late'));
  await step(() => calls[0].resolve());
  expect(calls.map((call) => call.text)).toEqual(['typed']);
  expect(results()).toEqual([]);
});

test('renders the action icon in the status color and the message', () => {
  const markup = renderToStaticMarkup(
    <ClipboardToast toast={{ action: 'copy', status: 'error', message: 'No new text.' }} />,
  );
  expect(markup).toContain('data-testid="clipboard-toast"');
  expect(markup).toContain('data-status="error"');
  expect(markup).toContain('color:var(--expo-theme-icon-danger)');
  expect(markup).toContain('color:var(--expo-theme-text-danger)');
  expect(markup).toContain('>No new text.</span>');
  const pasted = renderToStaticMarkup(
    <ClipboardToast toast={{ action: 'paste', status: 'success', message: 'Pasted into simulator' }} />,
  );
  expect(pasted).toContain('color:var(--expo-theme-icon-success)');
  expect(pasted).not.toContain('text-danger');
});
