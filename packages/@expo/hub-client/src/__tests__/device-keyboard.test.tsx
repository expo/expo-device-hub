import { afterEach, expect, test } from "bun:test";
import { act, create, type ReactTestRenderer } from "react-test-renderer";

import { type FoldControlCommand, type FoldPose } from "../fold";
import {
  type DeviceClient,
  type DeviceFold,
  type DeviceFoldCapabilities,
  type KeyboardInput,
} from "../types";
import { useDeviceKeyboard } from "../useDeviceKeyboard";
import { createGlobalStubs } from "./test-globals";

const { stubGlobal, restoreGlobals } = createGlobalStubs();

let renderer: ReactTestRenderer | undefined;
afterEach(async () => {
  if (renderer) await act(async () => renderer?.unmount());
  renderer = undefined;
  restoreGlobals();
});

function keyEvent(overrides: Partial<Record<string, unknown>>) {
  const event = {
    key: "a",
    code: "KeyA",
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

const ALL_POSES = { closed: {}, open: {}, laptop: {}, book: {}, tent: {} };

function foldCapabilities(poses: Partial<Record<FoldPose, object>>): DeviceFoldCapabilities {
  return {
    angle: { min: 0, max: 180 },
    poses: poses as Record<FoldPose, { angle: number }>,
    tableMode: false,
    faceDown: false,
  };
}

async function mount(fold: DeviceFold | null, foldControls: DeviceFoldCapabilities = false) {
  stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  stubGlobal("window", { addEventListener() {}, removeEventListener() {} });
  stubGlobal("document", { hidden: false, addEventListener() {}, removeEventListener() {} });
  const keys: KeyboardInput[] = [];
  const client = {
    sendKey: (input: KeyboardInput) => {
      keys.push(input);
      return true;
    },
    fold,
    pasteText: async () => {},
    // Clipboard shortcuts are covered by DeviceScreen's tests.
    capabilities: { clipboard: false, fold: foldControls },
  } as unknown as Pick<DeviceClient, "sendKey" | "fold" | "pasteText" | "capabilities">;
  function Harness() {
    const keyboard = useDeviceKeyboard(client);
    return <div onKeyDown={keyboard.onKeyDown as never} onKeyUp={keyboard.onKeyUp as never} />;
  }
  await act(async () => {
    renderer = create(<Harness />);
  });
  const surface = renderer!.root.findByType("div");
  return { keys, surface };
}

test("Option+Shift+1–5 select the Duo poses in Xcode order and never reach the device as keys", async () => {
  const commands: FoldControlCommand[] = [];
  const setControl = (command: FoldControlCommand) => {
    commands.push(command);
  };
  const { keys, surface } = await mount(
    { setControl } as unknown as DeviceFold,
    foldCapabilities(ALL_POSES),
  );
  for (const [digit, pose] of [
    ["Digit1", "closed"],
    ["Digit2", "open"],
    ["Digit3", "laptop"],
    ["Digit4", "book"],
    ["Digit5", "tent"],
  ] as const) {
    const event = keyEvent({ key: "!", code: digit, altKey: true, shiftKey: true });
    await act(async () => surface.props.onKeyDown(event));
    expect(event.prevented).toBe(true);
    expect(commands.at(-1)).toEqual({ control: "pose", value: pose });
  }
  // Releasing a consumed shortcut key sends nothing either: the device never
  // saw the press, so it must not see a release.
  const release = keyEvent({ code: "Digit5" });
  await act(async () => surface.props.onKeyUp(release));
  expect(release.prevented).toBe(true);
  expect(keys).toHaveLength(0);
  // Auto-repeat does not resend, and Command+digits stay with the browser.
  await act(async () =>
    surface.props.onKeyDown(
      keyEvent({ code: "Digit1", altKey: true, shiftKey: true, repeat: true }),
    ),
  );
  expect(commands).toHaveLength(5);
  const tabSwitch = keyEvent({ code: "Digit1", altKey: true, shiftKey: true, metaKey: true });
  await act(async () => surface.props.onKeyDown(tabSwitch));
  expect(commands).toHaveLength(5);
  // That Command+digit press was forwarded, so its release is forwarded too.
  await act(async () => surface.props.onKeyUp(keyEvent({ code: "Digit1", metaKey: true })));
  expect(
    keys
      .filter((input) => input.code.startsWith("Digit"))
      .map((input) => `${input.code}:${input.phase}`),
  ).toEqual(["Digit1:down", "Digit1:up"]);
});

test("a digit whose pose the device does not offer is consumed and does nothing", async () => {
  const commands: FoldControlCommand[] = [];
  const setControl = (command: FoldControlCommand) => {
    commands.push(command);
  };
  // An Android emulator offers Fully folded, Partially open (book), and Fully open.
  const { keys, surface } = await mount(
    { setControl } as unknown as DeviceFold,
    foldCapabilities({ closed: {}, book: {}, open: {} }),
  );
  for (const digit of ["Digit3", "Digit5"]) {
    const event = keyEvent({ code: digit, altKey: true, shiftKey: true });
    await act(async () => surface.props.onKeyDown(event));
    expect(event.prevented).toBe(true);
    const release = keyEvent({ code: digit });
    await act(async () => surface.props.onKeyUp(release));
    expect(release.prevented).toBe(true);
  }
  expect(commands).toHaveLength(0);
  expect(keys).toHaveLength(0);
  await act(async () =>
    surface.props.onKeyDown(keyEvent({ code: "Digit4", altKey: true, shiftKey: true })),
  );
  expect(commands).toEqual([{ control: "pose", value: "book" }]);
});

for (const [name, fold, foldControls] of [
  ["without a fold", null, false],
  // Like serve-sim, the shortcut waits for the simulator to report its hinge.
  ["before the simulator reports its hinge", {}, false],
] as const) {
  test(`${name} the shortcut is an ordinary keystroke`, async () => {
    const commands: FoldControlCommand[] = [];
    const setControl = (command: FoldControlCommand) => {
      commands.push(command);
    };
    const { keys, surface } = await mount(
      fold && ({ ...fold, setControl } as unknown as DeviceFold),
      foldControls,
    );
    const event = keyEvent({ code: "Digit2", altKey: true, shiftKey: true });
    await act(async () => surface.props.onKeyDown(event));
    expect(keys).toEqual([
      {
        phase: "down",
        code: "Digit2",
        key: "a",
        repeat: false,
        shiftKey: true,
        metaKey: false,
        ctrlKey: false,
        altKey: true,
      },
    ]);
    await act(async () => surface.props.onKeyUp(keyEvent({ code: "Digit2" })));
    expect(keys.at(-1)).toEqual({
      phase: "up",
      code: "Digit2",
      key: "a",
      repeat: false,
      shiftKey: false,
      metaKey: false,
      ctrlKey: false,
      altKey: false,
    });
    expect(commands).toHaveLength(0);
  });
}
