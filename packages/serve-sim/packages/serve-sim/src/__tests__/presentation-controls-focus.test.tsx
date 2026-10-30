import { expect, test } from "bun:test";
import { act, create, type ReactTestRenderer } from "react-test-renderer";
import { PresentationControls } from "../client/components/presentation-controls";

test("mobile presentation actions retain keyboard focus without canceling clicks", async () => {
  const previousWindow = globalThis.window;
  const previousAct = Reflect.get(globalThis, "IS_REACT_ACT_ENVIRONMENT");
  Object.assign(globalThis, { window: new EventTarget(), IS_REACT_ACT_ENVIRONMENT: true });
  let renderer: ReactTestRenderer | undefined;
  let exits = 0;
  try {
    for (const keyboardRaised of [true, false]) {
      await act(async () => {
        renderer = create(<PresentationControls onExit={() => exits++} {...{ keyboardRaised }} />);
      });
      const controls = renderer!.root.findAllByType("div")[0]!;
      let prevented = false;
      controls.props.onMouseDownCapture?.({
        preventDefault: () => {
          prevented = true;
        },
      });
      expect(prevented).toBe(keyboardRaised);
      await act(async () => {
        renderer!.root.findByProps({ "aria-label": "Exit full screen" }).props.onClick();
      });
      await act(async () => renderer?.unmount());
      renderer = undefined;
    }
    expect(exits).toBe(2);
  } finally {
    if (renderer) await act(async () => renderer?.unmount());
    Object.assign(globalThis, { window: previousWindow, IS_REACT_ACT_ENVIRONMENT: previousAct });
  }
});
