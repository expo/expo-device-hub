import { expect, test } from "bun:test";
import { onDrawerEscape } from "../client/utils/drawer-escape";

const keydown = (key: string): Event => Object.assign(new Event("keydown", { cancelable: true }), { key });

function harness(controlTakesEscape: boolean) {
  const target = new EventTarget();
  target.addEventListener("keydown", (event) => {
    if (controlTakesEscape && (event as Event & { key: string }).key === "Escape") {
      event.stopImmediatePropagation();
    }
  });
  let handled = 0;
  const stop = onDrawerEscape(target, () => (handled += 1));
  const forwarded: string[] = [];
  target.addEventListener("keydown", (event) => forwarded.push((event as Event & { key: string }).key));
  return { target, stop, forwarded, handled: () => handled };
}

test("the drawer takes an Escape nothing else handled and keeps it from the simulator's key forwarding", () => {
  const { target, stop, forwarded, handled } = harness(false);
  const escape = keydown("Escape");
  target.dispatchEvent(escape);
  target.dispatchEvent(keydown("a"));
  stop();
  target.dispatchEvent(keydown("Escape"));

  expect(handled()).toBe(1);
  expect(escape.defaultPrevented).toBe(true);
  expect(forwarded).toEqual(["a", "Escape"]);
});

test("an open control inside the drawer gets Escape first, so the drawer stays open", () => {
  const { target, stop, forwarded, handled } = harness(true);
  target.dispatchEvent(keydown("Escape"));
  stop();

  expect(handled()).toBe(0);
  expect(forwarded).toEqual([]);
});
