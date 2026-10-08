import { afterEach, expect, test } from 'bun:test';
import { renderToStaticMarkup } from 'react-dom/server';
import { act, create, type ReactTestInstance, type ReactTestRenderer } from 'react-test-renderer';

import { type DeviceClient, type DeviceClipboardCapabilities } from '@expo/hub-client';
import { Button } from '../components/Button';
import { ClipboardSection } from '../dashboard/ClipboardSection';
import { SECTION_TRANSITION_MS } from '../dashboard/CollapsibleSection';
import { type ClipboardRequest, HARDWARE_KEYBOARD_NOTE } from '../dashboard/ClipboardToast';
import { createGlobalStubs } from './test-globals';

const { stubGlobal, restoreGlobals } = createGlobalStubs();

let renderer: ReactTestRenderer | undefined;
afterEach(async () => {
  if (renderer) await act(async () => renderer?.unmount());
  renderer = undefined;
  restoreGlobals();
});

function clipboardClient(
  clipboard: DeviceClipboardCapabilities,
  overrides: Partial<DeviceClient> = {},
): DeviceClient {
  return {
    capabilities: { clipboard },
    hardwareKeyboardConnected: true,
    pasteText: async () => {},
    copyText: async () => '',
    ...overrides,
  } as DeviceClient;
}

function markup(client: DeviceClient) {
  return renderToStaticMarkup(<ClipboardSection client={client} defaultOpen />);
}

test('shows only the clipboard actions that the device offers, Copy first as in serve-sim', () => {
  const both = markup(clipboardClient({ paste: true, copy: true }));
  expect(both).toContain('<section aria-label="Clipboard"');
  expect(both.indexOf('>Copy from Simulator</span>')).toBeLessThan(both.indexOf('>Send</span>'));
  expect(both).toContain('placeholder="Paste here to send it to the simulator"');
  expect(both).toContain('aria-label="Text to paste into the simulator"');
  expect(both).toContain('>Send</span>');
  expect(both).toContain('>Copy from Simulator</span>');
  // The copied-text field appears after a Copy.
  expect(both).not.toContain('aria-label="Copied text"');

  const pasteOnly = markup(clipboardClient({ paste: true, copy: false }));
  expect(pasteOnly).toContain('>Send</span>');
  expect(pasteOnly).not.toContain('>Copy from Simulator</span>');

  const copyOnly = markup(clipboardClient({ paste: false, copy: true }));
  expect(copyOnly).not.toContain('aria-label="Text to paste into the simulator"');
  expect(copyOnly).toContain('>Copy from Simulator</span>');

  expect(markup(clipboardClient(false))).toBe('');
  expect(markup(clipboardClient({ paste: false, copy: false }))).toBe('');
});

test('says that Paste and Copy need the hardware keyboard while it is off', () => {
  expect(markup(clipboardClient({ paste: true, copy: true }))).not.toContain(HARDWARE_KEYBOARD_NOTE);
  expect(
    markup(clipboardClient({ paste: true, copy: true }, { hardwareKeyboardConnected: false })),
  ).toContain(HARDWARE_KEYBOARD_NOTE);
});

async function setup(
  client: DeviceClient,
  props: { request?: ClipboardRequest | null; onRequestHandled?: () => void } = {},
) {
  stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
  stubGlobal('window', { setTimeout, clearTimeout });
  const focused: string[] = [];
  const selected: string[] = [];
  const scrolled: string[] = [];
  await act(async () => {
    renderer = create(<ClipboardSection client={client} {...props} />, {
      createNodeMock: (element) => {
        if (element.type !== 'textarea') return null;
        const label = (element.props as { 'aria-label': string })['aria-label'];
        return {
          focus: () => focused.push(label),
          select: () => selected.push(label),
          scrollIntoView: () => scrolled.push(label),
        };
      },
    });
  });
  const root = renderer!.root;
  const button = (label: string) =>
    root.findAllByType(Button).find((node: ReactTestInstance) => node.props.children === label);
  const field = (label: string) => root.findByProps({ 'aria-label': label });
  return {
    focused,
    selected,
    scrolled,
    button,
    field,
    expanded: () => root.findByProps({ 'aria-expanded': true, type: 'button' }) !== undefined,
    click: (label: string) => act(async () => button(label)!.props.onClick()),
    type: (label: string, value: string) =>
      act(async () => field(label).props.onChange({ currentTarget: { value } })),
    update: (next: { request?: ClipboardRequest | null }) =>
      act(async () => renderer!.update(<ClipboardSection client={client} {...props} {...next} />)),
  };
}

test('pastes the typed text and clears the field', async () => {
  const pastes: Array<string | undefined> = [];
  const s = await setup(
    clipboardClient({ paste: true, copy: true }, { pasteText: async (text) => void pastes.push(text) }),
    { request: { action: 'paste' } },
  );

  expect(s.button('Send')!.props.disabled).toBe(true);
  await s.type('Text to paste into the simulator', 'hello from the Hub');
  expect(s.button('Send')!.props.disabled).toBe(false);
  await s.click('Send');
  expect(pastes).toEqual(['hello from the Hub']);
  expect(s.field('Text to paste into the simulator').props.value).toBe('');
});

test('keeps the typed text and shows the error when Paste fails', async () => {
  const s = await setup(
    clipboardClient(
      { paste: true, copy: false },
      {
        pasteText: async () => {
          throw new Error('Input is disconnected.');
        },
      },
    ),
    { request: { action: 'paste' } },
  );

  await s.type('Text to paste into the simulator', 'keep me');
  await s.click('Send');
  expect(s.field('Text to paste into the simulator').props.value).toBe('keep me');
  expect(renderer!.root.findByProps({ role: 'alert' }).props.children).toBe('Input is disconnected.');
});

test('shows the copied text in a read-only field and copies it to the browser clipboard', async () => {
  const written: string[] = [];
  stubGlobal('navigator', { clipboard: { writeText: async (text: string) => void written.push(text) } });
  const s = await setup(
    clipboardClient({ paste: false, copy: true }, { copyText: async () => 'selected in the app' }),
    { request: null },
  );

  await act(async () => renderer!.root.findByProps({ 'aria-expanded': false }).props.onClick());
  await s.click('Copy from Simulator');
  expect(s.field('Copied text').props.value).toBe('selected in the app');
  expect(s.field('Copied text').props.readOnly).toBe(true);
  await s.click('Copy');
  expect(written).toEqual(['selected in the app']);
  expect(renderer!.root.findByProps({ role: 'status' }).props.children).toBe('Copied from simulator');
});

function refuseBrowserClipboard(copyCommand: boolean) {
  const commands: string[] = [];
  stubGlobal('navigator', {
    clipboard: {
      writeText: async () => {
        throw new Error('Document is not focused.');
      },
    },
  });
  stubGlobal('document', {
    execCommand: (command: string) => {
      commands.push(command);
      return copyCommand;
    },
  });
  return commands;
}

test('copies the selected field, as serve-sim does, when the browser clipboard refuses the text', async () => {
  const commands = refuseBrowserClipboard(true);
  const s = await setup(clipboardClient({ paste: false, copy: true }), {
    request: { action: 'copy', text: 'from the toolbar' },
  });

  s.selected.length = 0;
  await s.click('Copy');
  expect(s.selected).toEqual(['Copied text']);
  expect(commands).toEqual(['copy']);
  expect(renderer!.root.findByProps({ role: 'status' }).props.children).toBe('Copied from simulator');
});

test('leaves the copied text selected when the selection copy also fails', async () => {
  const commands = refuseBrowserClipboard(false);
  const s = await setup(clipboardClient({ paste: false, copy: true }), {
    request: { action: 'copy', text: 'from the toolbar' },
  });

  s.selected.length = 0;
  await s.click('Copy');
  expect(s.selected).toEqual(['Copied text']);
  expect(commands).toEqual(['copy']);
  expect(renderer!.root.findByProps({ role: 'status' }).props.children).toBe(
    'Copy failed. Press Command+C or Ctrl+C to copy the selected text',
  );
});

test('a Copy during a Paste keeps Send disabled and the Paste in flight', async () => {
  let finishPaste!: () => void;
  let finishCopy!: (text: string) => void;
  const s = await setup(
    clipboardClient(
      { paste: true, copy: true },
      {
        pasteText: () => new Promise<void>((resolve) => (finishPaste = resolve)),
        copyText: () => new Promise<string>((resolve) => (finishCopy = resolve)),
      },
    ),
    { request: { action: 'paste' } },
  );
  const notes = () =>
    renderer!.root
      .findAll((node) => typeof node.type === 'string' && node.props.role === 'status')
      .map((node) => node.props.children as string);

  await s.type('Text to paste into the simulator', 'hello');
  await s.click('Send');
  await s.click('Copy from Simulator');
  expect(s.button('Send')!.props.disabled).toBe(true);
  expect(s.button('Copy from Simulator')!.props.disabled).toBe(true);
  expect(notes()).toEqual(['Reading simulator clipboard…', 'Pasting into the simulator…']);

  await act(async () => finishCopy('copied'));
  expect(s.button('Send')!.props.disabled).toBe(true);
  expect(s.button('Copy from Simulator')!.props.disabled).toBe(false);
  expect(notes()).toEqual(['Pasting into the simulator…']);

  await act(async () => finishPaste());
  expect(notes()).toEqual([]);
});

test('opens for a stopped toolbar Paste and focuses the paste field', async () => {
  let handled = 0;
  const s = await setup(clipboardClient({ paste: true, copy: true }), {
    request: { action: 'paste' },
    onRequestHandled: () => handled++,
  });

  expect(s.expanded()).toBe(true);
  expect(s.focused).toEqual(['Text to paste into the simulator']);
  expect(handled).toBe(1);
  // The field scrolls into view once the section has expanded.
  expect(s.scrolled).toEqual([]);
  await act(async () => new Promise((resolve) => setTimeout(resolve, SECTION_TRANSITION_MS + 20)));
  expect(s.scrolled).toEqual(['Text to paste into the simulator']);
});

test('opens for a stopped toolbar Copy with its text selected', async () => {
  let handled = 0;
  const s = await setup(clipboardClient({ paste: true, copy: true }), {
    request: null,
    onRequestHandled: () => handled++,
  });
  expect(renderer!.root.findAllByProps({ 'aria-expanded': true })).toHaveLength(0);

  await s.update({ request: { action: 'copy', text: 'copied by the toolbar' } });
  expect(s.expanded()).toBe(true);
  expect(s.field('Copied text').props.value).toBe('copied by the toolbar');
  expect(s.focused).toEqual(['Copied text']);
  expect(s.selected).toEqual(['Copied text']);
  expect(handled).toBe(1);
});
