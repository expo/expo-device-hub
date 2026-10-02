import { afterEach, expect, test } from "bun:test";
import { nativeTextEdits, runBlurScenario, waitForActivityRecovery } from "./scenarios";

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

test("expired-input assertions ignore readiness notifications but retain every text edit", () => {
  const before = "keyboard-ready\ntext\t1\thub!\n";
  expect(nativeTextEdits(before + "software-keyboard-ready\n")).toBe(nativeTextEdits(before));
  expect(nativeTextEdits(before + "text\t2\thub!x\ntext\t3\thub!\n")).not.toBe(
    nativeTextEdits(before),
  );
});

function setupActivity(sampleTime: number | null, message = "", connection = 2) {
  stub("document", {
    querySelector: () => ({
      getAttribute: () => (sampleTime === null ? null : String(sampleTime)),
      textContent: message,
      querySelectorAll: () => [{}, {}, {}],
    }),
  });
  stub("fetch", async () =>
    Response.json({
      events: [
        { channel: "control", connection, path: "/metrics", subscriptionId: 1 },
        {
          channel: "control",
          connection,
          subscriptionId: 1,
          subscriptionData: true,
          sampleTime: 200,
        },
      ],
    }),
  );
}

test("subscription recovery rejects upstream data that never reaches Activity", async () => {
  setupActivity(null, "Activity data is unavailable for this app.");
  await expect(waitForActivityRecovery(1, 100, 150)).rejects.toThrow(
    "Activity renders a fresh native sample",
  );
});

test("subscription recovery rejects stale charts even with upstream replacement data", async () => {
  setupActivity(100);
  await expect(waitForActivityRecovery(1, 100, 150)).rejects.toThrow(
    "Activity renders a fresh native sample",
  );
});

test("subscription recovery rejects paused charts and data from the retired connection", async () => {
  setupActivity(200, "Activity data is paused.");
  await expect(waitForActivityRecovery(1, 100, 150)).rejects.toThrow(
    "Activity renders a fresh native sample",
  );
  setupActivity(200, "", 1);
  await expect(waitForActivityRecovery(1, 100, 150)).rejects.toThrow(
    "Activity renders a fresh native sample",
  );
});

test("subscription recovery accepts a fresh replacement sample rendered by Activity", async () => {
  setupActivity(200);
  await expect(waitForActivityRecovery(1, 100, 150)).resolves.toBeUndefined();
});
