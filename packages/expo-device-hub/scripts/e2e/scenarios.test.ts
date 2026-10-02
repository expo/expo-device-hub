import { afterEach, expect, test } from "bun:test";
import { runBlurScenario } from "./scenarios";

const restore: (() => void)[] = [];
afterEach(() =>
  restore
    .splice(0)
    .reverse()
    .forEach((reset) => reset()),
);
function stub(name: string, value: unknown) {
  const previous = Object.getOwnPropertyDescriptor(globalThis, name);
  Object.defineProperty(globalThis, name, { configurable: true, value });
  restore.push(() => {
    if (previous) Object.defineProperty(globalThis, name, previous);
    else Reflect.deleteProperty(globalThis, name);
  });
}

function setup(staleMove: boolean) {
  let log = "input-ready\n";
  const events: { tag: number; type: string }[] = [];
  const target = {
    getBoundingClientRect: () => ({ left: 0, top: 0, width: 100, height: 200 }),
    dispatchEvent(event: Event) {
      if (event.type === "pointerdown") log += "touch-began\n";
      if (event.type === "pointermove" && staleMove)
        setTimeout(() => events.push({ tag: 3, type: "move" }), 1);
    },
  };
  stub("document", { querySelector: () => target });
  stub("PointerEvent", Event);
  stub("window", {
    dispatchEvent() {
      setTimeout(() => {
        log += "touch-ended\n";
      }, 5);
    },
  });
  stub("fetch", async (url: string) => {
    if (url === "/_e2e/fixture") return new Response(log);
    if (url === "/_e2e/state") return Response.json({ events });
    return Response.json({ ok: true });
  });
}

test("the native blur scenario rejects movement delivered during its end wait", async () => {
  setup(true);
  await expect(runBlurScenario()).rejects.toThrow("Cancelled animation frame");
});

test("the native blur scenario accepts cancellation with no movement", async () => {
  setup(false);
  await expect(runBlurScenario()).resolves.toBeUndefined();
});
