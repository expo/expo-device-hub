import { afterEach, expect, test } from 'bun:test';
import { act, create, type ReactTestRenderer } from 'react-test-renderer';

import { DeviceScreen } from '../DeviceScreen';
import { type DeviceClipboardCapabilities, type KeyboardInput } from '../types';
import { NOOP_DEVICE_CLIENT } from '../useNoopDeviceClient';
import { createGlobalStubs } from './test-globals';

const { stubGlobal, restoreGlobals } = createGlobalStubs();
let renderer: ReactTestRenderer | undefined;
afterEach(async () => {
  await act(async () => renderer?.unmount());
  renderer = undefined;
  restoreGlobals();
});

async function setup(clipboard: DeviceClipboardCapabilities = { paste: true, copy: true }) {
  stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
  stubGlobal('window', { addEventListener() {}, removeEventListener() {} });
  stubGlobal('document', { hidden: false, addEventListener() {}, removeEventListener() {} });
  const keys: KeyboardInput[] = [];
  const pastes: Array<string | undefined> = [];
  const client = {
    ...NOOP_DEVICE_CLIENT,
    status: 'streaming' as const,
    capabilities: { ...NOOP_DEVICE_CLIENT.capabilities, clipboard },
    sendKey: (input: KeyboardInput) => {
      keys.push(input);
      return true;
    },
    pasteText: async (text?: string) => {
      pastes.push(text);
    },
  };
  const surface = { focus() {}, addEventListener() {}, removeEventListener() {} };
  await act(async () => {
    renderer = create(<DeviceScreen client={client} />, { createNodeMock: () => surface });
  });
  const overlay = renderer!.root.findByProps({ role: 'application' });
  const keyEvent = (code: string, key: string, modifiers: { metaKey?: boolean; ctrlKey?: boolean; repeat?: boolean } = {}) => {
    const event = {
      code, key, repeat: false, shiftKey: false, metaKey: false, ctrlKey: false, altKey: false, ...modifiers,
      nativeEvent: { isComposing: false },
      defaultPrevented: false,
      preventDefault() { event.defaultPrevented = true; },
    };
    return event;
  };
  const pasteEvent = (text: string) => {
    const event = {
      clipboardData: { getData: (type: string) => (type === 'text/plain' ? text : '') },
      defaultPrevented: false,
      preventDefault() { event.defaultPrevented = true; },
    };
    return event;
  };
  return {
    keys,
    pastes,
    down: (event: ReturnType<typeof keyEvent>) => act(async () => overlay.props.onKeyDown(event)),
    up: (event: ReturnType<typeof keyEvent>) => act(async () => overlay.props.onKeyUp(event)),
    paste: (event: ReturnType<typeof pasteEvent>) => act(async () => overlay.props.onPaste(event)),
    keyEvent,
    pasteEvent,
  };
}

test('Cmd+V sends the paste event text and never the V key', async () => {
  const s = await setup();
  const meta = s.keyEvent('MetaLeft', 'Meta', { metaKey: true });
  await s.down(meta);
  const v = s.keyEvent('KeyV', 'v', { metaKey: true });
  await s.down(v);
  // The browser fires `paste` only when the keydown keeps its default action.
  expect(v.defaultPrevented).toBe(false);
  const paste = s.pasteEvent('from the browser');
  await s.paste(paste);
  expect(paste.defaultPrevented).toBe(true);
  const vUp = s.keyEvent('KeyV', 'v', { metaKey: true });
  await s.up(vUp);
  await s.up(s.keyEvent('MetaLeft', 'Meta'));
  expect(s.pastes).toEqual(['from the browser']);
  expect(vUp.defaultPrevented).toBe(true);
  expect(s.keys.map((key) => `${key.phase} ${key.code}`)).toEqual(['down MetaLeft', 'up MetaLeft']);
});

test('Cmd+V without browser text pastes the device clipboard', async () => {
  const s = await setup();
  await s.down(s.keyEvent('KeyV', 'v', { metaKey: true }));
  await s.paste(s.pasteEvent(''));
  await s.up(s.keyEvent('KeyV', 'v', { metaKey: true }));
  expect(s.pastes).toEqual([undefined]);
});

test('Ctrl+V without a paste event pastes the device clipboard on keyup', async () => {
  const s = await setup();
  await s.down(s.keyEvent('KeyV', 'v', { ctrlKey: true }));
  const repeat = s.keyEvent('KeyV', 'v', { ctrlKey: true, repeat: true });
  await s.down(repeat);
  expect(repeat.defaultPrevented).toBe(true);
  await s.up(s.keyEvent('KeyV', 'v', { ctrlKey: true }));
  expect(s.pastes).toEqual([undefined]);
  expect(s.keys).toEqual([]);
});

test('a paste event without text or shortcut is left alone', async () => {
  const s = await setup();
  const paste = s.pasteEvent('');
  await s.paste(paste);
  expect(paste.defaultPrevented).toBe(false);
  expect(s.pastes).toEqual([]);
  // A menu paste with text still reaches the device.
  await s.paste(s.pasteEvent('menu'));
  expect(s.pastes).toEqual(['menu']);
});

test('a plain V and Cmd+C stay keys', async () => {
  const s = await setup();
  await s.down(s.keyEvent('KeyV', 'v'));
  await s.up(s.keyEvent('KeyV', 'v'));
  await s.down(s.keyEvent('KeyC', 'c', { metaKey: true }));
  await s.up(s.keyEvent('KeyC', 'c', { metaKey: true }));
  expect(s.keys.map((key) => `${key.phase} ${key.code}`)).toEqual(['down KeyV', 'up KeyV', 'down KeyC', 'up KeyC']);
  expect(s.pastes).toEqual([]);
});

test('without the paste capability Cmd+V stays raw keys', async () => {
  const s = await setup({ paste: false, copy: true });
  const v = s.keyEvent('KeyV', 'v', { metaKey: true });
  await s.down(v);
  expect(v.defaultPrevented).toBe(true);
  const paste = s.pasteEvent('ignored');
  await s.paste(paste);
  await s.up(s.keyEvent('KeyV', 'v', { metaKey: true }));
  expect(paste.defaultPrevented).toBe(false);
  expect(s.pastes).toEqual([]);
  expect(s.keys.map((key) => `${key.phase} ${key.code}`)).toEqual(['down KeyV', 'up KeyV']);
});
