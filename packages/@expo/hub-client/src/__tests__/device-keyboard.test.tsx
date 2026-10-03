import { afterEach, expect, test } from 'bun:test';
import { act, create, type ReactTestRenderer } from 'react-test-renderer';

import { type HingeControlCommand } from '../hinge-control';
import { type DeviceClient, type DeviceHinge, type KeyboardInput } from '../types';
import { useDeviceKeyboard } from '../useDeviceKeyboard';
import { createGlobalStubs } from './test-globals';

const { stubGlobal, restoreGlobals } = createGlobalStubs();

let renderer: ReactTestRenderer | undefined;
afterEach(async () => {
  if (renderer) await act(async () => renderer?.unmount());
  renderer = undefined;
  restoreGlobals();
});

function keyEvent(overrides: Partial<Record<string, unknown>>) {
  const event = {
    key: 'a',
    code: 'KeyA',
    altKey: false,
    shiftKey: false,
    metaKey: false,
    ctrlKey: false,
    repeat: false,
    prevented: false,
    preventDefault() {
      event.prevented = true;
    },
    currentTarget: { blur() {} },
    nativeEvent: { isComposing: false },
    ...overrides,
  };
  return event;
}

async function mount(hinge: DeviceHinge | null) {
  stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
  stubGlobal('window', { addEventListener() {}, removeEventListener() {} });
  stubGlobal('document', { hidden: false, addEventListener() {}, removeEventListener() {} });
  const keys: KeyboardInput[] = [];
  const client = {
    sendKey: (input: KeyboardInput) => {
      keys.push(input);
      return true;
    },
    hinge,
  } as unknown as Pick<DeviceClient, 'sendKey' | 'hinge'>;
  function Harness() {
    const keyboard = useDeviceKeyboard(client);
    return <div onKeyDown={keyboard.onKeyDown as never} onKeyUp={keyboard.onKeyUp as never} />;
  }
  await act(async () => {
    renderer = create(<Harness />);
  });
  const surface = renderer!.root.findByType('div');
  return { keys, surface };
}

test('Option+Shift+1–5 select the Duo poses in Xcode order and never reach the device as keys', async () => {
  const commands: HingeControlCommand[] = [];
  const setControl = (command: HingeControlCommand) => {
    commands.push(command);
  };
  const { keys, surface } = await mount({ setControl } as unknown as DeviceHinge);
  for (const [digit, pose] of [
    ['Digit1', 'closed'],
    ['Digit2', 'open'],
    ['Digit3', 'laptop'],
    ['Digit4', 'book'],
    ['Digit5', 'tent'],
  ] as const) {
    const event = keyEvent({ key: '!', code: digit, altKey: true, shiftKey: true });
    await act(async () => surface.props.onKeyDown(event));
    expect(event.prevented).toBe(true);
    expect(commands.at(-1)).toEqual({ control: 'pose', value: pose });
  }
  // Releasing a consumed shortcut key sends nothing either: the device never
  // saw the press, so it must not see a release.
  const release = keyEvent({ code: 'Digit5' });
  await act(async () => surface.props.onKeyUp(release));
  expect(release.prevented).toBe(true);
  expect(keys).toHaveLength(0);
  // Auto-repeat does not resend, and Command+digits stay with the browser.
  await act(async () => surface.props.onKeyDown(keyEvent({ code: 'Digit1', altKey: true, shiftKey: true, repeat: true })));
  expect(commands).toHaveLength(5);
  const tabSwitch = keyEvent({ code: 'Digit1', altKey: true, shiftKey: true, metaKey: true });
  await act(async () => surface.props.onKeyDown(tabSwitch));
  expect(commands).toHaveLength(5);
  // That Command+digit press was forwarded, so its release is forwarded too.
  await act(async () => surface.props.onKeyUp(keyEvent({ code: 'Digit1', metaKey: true })));
  expect(keys.filter((input) => input.code.startsWith('Digit')).map((input) => `${input.code}:${input.phase}`)).toEqual([
    'Digit1:down',
    'Digit1:up',
  ]);
});

test('without a hinge the shortcut is an ordinary keystroke', async () => {
  const { keys, surface } = await mount(null);
  const event = keyEvent({ code: 'Digit2', altKey: true, shiftKey: true });
  await act(async () => surface.props.onKeyDown(event));
  expect(keys).toEqual([{ phase: 'down', code: 'Digit2', key: 'a', repeat: false }]);
  await act(async () => surface.props.onKeyUp(keyEvent({ code: 'Digit2' })));
  expect(keys.at(-1)).toEqual({ phase: 'up', code: 'Digit2', key: 'a', repeat: false });
});
