import { afterEach, expect, test } from "bun:test";
import { act, create, type ReactTestRenderer } from "react-test-renderer";

import { useVisibleTimeout } from "../foldable/useVisibleTimeout";
import { createGlobalStubs } from "./test-globals";

const { stubGlobal, restoreGlobals } = createGlobalStubs();
let renderer: ReactTestRenderer | undefined;
afterEach(async () => {
  await act(async () => renderer?.unmount());
  renderer = undefined;
  restoreGlobals();
});

function setup() {
  stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  const timers = new Map<number, () => void>();
  let id = 0;
  stubGlobal("setTimeout", (callback: () => void) => {
    timers.set(++id, callback);
    return id;
  });
  stubGlobal("clearTimeout", (timer: number) => timers.delete(timer));
  const listeners = new Set<() => void>();
  const document = {
    hidden: false,
    addEventListener: (_type: string, listener: () => void) => listeners.add(listener),
    removeEventListener: (_type: string, listener: () => void) => listeners.delete(listener),
  };
  stubGlobal("document", document);
  let fired = 0;
  function Harness({ active }: { active: boolean }) {
    useVisibleTimeout(active, 30_000, () => fired++);
    return null;
  }
  return {
    timers,
    get fired() {
      return fired;
    },
    render: async (active: boolean) => {
      await act(async () => {
        if (renderer) renderer.update(<Harness active={active} />);
        else renderer = create(<Harness active={active} />);
      });
    },
    setHidden: async (hidden: boolean) => {
      document.hidden = hidden;
      await act(async () => {
        for (const listener of [...listeners]) listener();
      });
    },
    fire: async () => {
      await act(async () => {
        for (const [key, callback] of [...timers]) {
          timers.delete(key);
          callback();
        }
      });
    },
  };
}

test("the 3D model timeout counts only while the tab is visible", async () => {
  const clock = setup();
  await clock.render(true);
  expect(clock.timers.size).toBe(1);
  // A hidden tab stops the wait; the visible tab starts it again.
  await clock.setHidden(true);
  expect(clock.timers.size).toBe(0);
  await clock.setHidden(false);
  expect(clock.timers.size).toBe(1);
  await clock.fire();
  expect(clock.fired).toBe(1);
});

test("a loaded model clears the timeout", async () => {
  const clock = setup();
  await clock.render(true);
  await clock.render(false);
  expect(clock.timers.size).toBe(0);
  expect(clock.fired).toBe(0);
});
