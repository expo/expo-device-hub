import { afterEach, beforeEach, expect, test } from "bun:test";
import { act, create, type ReactTestRenderer } from "react-test-renderer";

import { Tooltip } from "../components/Tooltip";
import { createGlobalStubs } from "./test-globals";

const { stubGlobal, restoreGlobals } = createGlobalStubs();
let renderer: ReactTestRenderer | undefined;

beforeEach(() => {
  stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  stubGlobal("window", { setTimeout, clearTimeout });
  stubGlobal("document", { addEventListener() {}, removeEventListener() {} });
});

afterEach(async () => {
  if (renderer) await act(async () => renderer?.unmount());
  renderer = undefined;
  restoreGlobals();
});

async function renderButton(content?: string) {
  await act(async () => {
    renderer = create(
      <Tooltip content={content}>
        <button type="button" aria-label="Home" aria-description="Go to the home screen" />
      </Tooltip>,
    );
  });
  return renderer!.root.findByType("button");
}

/** A pointer event as Radix reads it: the type of pointer, its pressed buttons, and whether a handler stopped it. */
function pointerMove(pointerType: string, buttons: number) {
  const event = {
    pointerType,
    buttons,
    defaultPrevented: false,
    preventDefault() {
      event.defaultPrevented = true;
    },
  };
  return event;
}

test("leaves the child's name and description to the child", async () => {
  const button = await renderButton("Home");

  // Radix would link the open tooltip as a description, and a tooltip that repeats the name
  // would be read twice.
  expect("aria-describedby" in button.props).toBe(true);
  expect(button.props["aria-describedby"]).toBeUndefined();
  expect(button.props["aria-label"]).toBe("Home");
  expect(button.props["aria-description"]).toBe("Go to the home screen");
  expect(button.props["data-state"]).toBe("closed");
});

test("stays closed for a pen that touches the screen", async () => {
  const button = await renderButton("Home");
  const press = pointerMove("pen", 1);
  await act(async () => button.props.onPointerMove(press));

  // Radix opens on a pointer move that no handler stopped. It leaves out touch only.
  expect(press.defaultPrevented).toBe(true);
  expect(button.props["data-state"]).toBe("closed");

  // A pen that hovers, and a mouse, are not stopped.
  for (const hover of [pointerMove("pen", 0), pointerMove("mouse", 0)]) {
    const wrapper = { ...hover };
    // Only the guard runs here: the event is marked as stopped first, so that Radix does not
    // open the tooltip, whose portal this renderer cannot draw.
    wrapper.defaultPrevented = false;
    let stopped = false;
    wrapper.preventDefault = () => {
      stopped = true;
    };
    Object.defineProperty(wrapper, "defaultPrevented", { get: () => true });
    await act(async () => button.props.onPointerMove(wrapper));
    expect(stopped).toBe(false);
  }
});

test("renders the child alone without content", async () => {
  const button = await renderButton(undefined);

  expect("data-state" in button.props).toBe(false);
  expect("onPointerMove" in button.props).toBe(false);
});
