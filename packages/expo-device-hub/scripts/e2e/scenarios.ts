import type { InputMode, WireEvent } from "./proxy";

declare global {
  interface Window {
    __hubE2E: { peers: RTCPeerConnection[]; errors: string[]; statsReads: number };
    __hubE2EResult?: {
      ok: boolean;
      cases: Array<{ name: string; durationMs: number }>;
      error?: string;
    };
  }
}
const pause = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));
function assert(value: unknown, message: string): asserts value {
  if (!value) throw new Error(message);
}
async function until<T>(
  read: () => T | Promise<T>,
  accept: (value: T) => boolean,
  description: string,
  timeoutMs = 20_000,
): Promise<T> {
  const started = performance.now();
  while (performance.now() - started < timeoutMs) {
    const value = await read();
    if (accept(value)) return value;
    await pause(100);
  }
  throw new Error(`Timed out: ${description}`);
}
async function post(path: string, body: object = {}) {
  const response = await fetch("/_e2e/" + path, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
  assert(response.ok, `${path}: ${response.status} ${await response.text()}`);
}
const state = async () =>
  (await (await fetch("/_e2e/state")).json()) as {
    mode: InputMode;
    controlConnections: number;
    events: WireEvent[];
    inputAttempts: Array<{ at: number; mode: InputMode; connection: number }>;
  };
const fixture = async () => await (await fetch("/_e2e/fixture")).text();
const refusal = () =>
  [...document.querySelectorAll('[role="status"]')].some((element) =>
    element.textContent?.includes("Simulator input unavailable"),
  );
const video = () => document.querySelector("video");
const frames = () => video()?.getVideoPlaybackQuality().totalVideoFrames ?? 0;
async function advancingVideo() {
  await until(
    () => video(),
    (element) => !!element && element.videoWidth > 0,
    "dashboard video has decoded dimensions",
    30_000,
  );
  const before = frames();
  await until(frames, (count) => count > before + 3, "dashboard presents later video frames");
}
function screen() {
  const element = document.querySelector<HTMLElement>('[role="application"]');
  assert(element, "Production DeviceScreen is mounted");
  return element;
}
function key(code: string, value: string, shiftKey = false) {
  const target = screen();
  target.focus();
  if (shiftKey)
    target.dispatchEvent(
      new KeyboardEvent("keydown", {
        code: "ShiftLeft",
        key: "Shift",
        shiftKey: true,
        bubbles: true,
        cancelable: true,
      }),
    );
  target.dispatchEvent(
    new KeyboardEvent("keydown", { code, key: value, shiftKey, bubbles: true, cancelable: true }),
  );
  target.dispatchEvent(
    new KeyboardEvent("keyup", { code, key: value, shiftKey, bubbles: true, cancelable: true }),
  );
  if (shiftKey)
    target.dispatchEvent(
      new KeyboardEvent("keyup", {
        code: "ShiftLeft",
        key: "Shift",
        shiftKey: false,
        bubbles: true,
        cancelable: true,
      }),
    );
}
function pointer(phase: "down" | "move" | "up", x: number, y: number, altKey = false) {
  const target = screen(),
    bounds = target.getBoundingClientRect();
  target.dispatchEvent(
    new PointerEvent("pointer" + phase, {
      pointerId: 1,
      pointerType: "mouse",
      button: 0,
      buttons: phase === "up" ? 0 : 1,
      altKey,
      bubbles: true,
      cancelable: true,
      clientX: bounds.left + bounds.width * x,
      clientY: bounds.top + bounds.height * y,
    }),
  );
}
function button(label: string) {
  const element = document.querySelector<HTMLButtonElement>(`button[aria-label="${label}"]`);
  assert(element, `Dashboard ${label} control exists`);
  return element;
}
function metricsReceived(events: WireEvent[], afterConnection = 0) {
  return events.some(
    (subscription) =>
      subscription.channel === "control" &&
      subscription.connection > afterConnection &&
      subscription.path?.startsWith("/metrics") &&
      events.some(
        (reply) =>
          reply.connection === subscription.connection &&
          reply.subscriptionId === subscription.subscriptionId &&
          reply.subscriptionData === true,
      ),
  );
}

/** Executes in the real browser, through production DOM handlers and native input.
 * Synthetic DOM events make the same cases runnable in the collaborative browser
 * and headless runner. OS focus/trusted-event delivery is a separate acceptance check.
 */
export async function runScenarios() {
  const cases: Array<{ name: string; durationMs: number }> = [];
  async function check(name: string, run: () => Promise<void>) {
    const started = performance.now();
    await run();
    cases.push({ name, durationMs: Math.round(performance.now() - started) });
  }
  try {
    await post("start");
    await check("Dashboard decodes advancing H264 frames", async () => {
      await advancingVideo();
      assert(
        document.body.textContent?.includes("E2E iPhone"),
        "Test device appears in real sidebar",
      );
      const peer = window.__hubE2E.peers.at(-1);
      assert(peer?.connectionState === "connected", "Actual WebRTC peer is connected");
      const report = await peer.getStats();
      const inbound = [...report.values()].find(
        (item) => item.type === "inbound-rtp" && item.kind === "video",
      );
      const codec = inbound?.codecId ? report.get(inbound.codecId) : undefined;
      assert(codec?.mimeType?.toLowerCase() === "video/h264", "Actual inbound codec is H264");
    });
    await check("Keyboard reaches native UIKit through DeviceScreen", async () => {
      await until(
        state,
        (value) => value.events.some((event) => event.channel === "input" && event.tag === 14),
        "separate input connection is admitted",
      );
      await until(fixture, (text) => text.includes("keyboard-ready"), "native fixture field ready");
      await until(
        fixture,
        (text) => text.includes("software-keyboard-ready"),
        "UIKit confirms software keyboard appeared after hardware keyboard disconnect",
      );
      key("KeyH", "h");
      key("KeyU", "u");
      key("KeyB", "b");
      await until(
        fixture,
        (text) => /text\t\d+\thub\n/.test(text),
        "native field contains exact hub text",
      );
      key("Digit1", "!", true);
      await until(
        fixture,
        (text) => /text\t\d+\thub!\n/.test(text),
        "native field receives shifted punctuation",
      );
    });
    await check(
      "Refusal stays visible through unadmitted OPEN; admission recovers input",
      async () => {
        await post("input", { mode: "refuse" });
        await until(refusal, Boolean, "persistent input refusal is announced", 25_000);
        const before = await fixture();
        const transition = Date.now();
        await post("input", { mode: "delay-refuse" });
        await until(
          state,
          (value) =>
            value.inputAttempts.some(
              (item) => item.mode === "delay-refuse" && item.at >= transition,
            ),
          "retry handshake completes before delayed refusal",
        );
        key("KeyX", "x");
        await pause(1_200);
        assert(refusal(), "OPEN did not clear refusal after one second");
        assert(
          !(await state()).events.some(
            (event) => event.channel === "input" && event.mode === "delay-refuse",
          ),
          "No input flushed before server admission",
        );
        await advancingVideo();
        await pause(1_600); // The queued x expires before later recovery.
        await post("input", { mode: "normal" });
        await until(refusal, (value) => !value, "native admission clears refusal");
        assert(
          (await fixture()) === before,
          "Expired unadmitted key was not replayed into native app",
        );
        key("KeyY", "y");
        await until(
          fixture,
          (text) => /text\t\d+\thub!y\n/.test(text),
          "native input works after admission",
        );
      },
    );
    await check("Blur ends a live native drag and cancels queued movement", async () => {
      await post("launch", { keyboard: false });
      await until(fixture, (text) => text.includes("input-ready"), "native touch fixture ready");
      const before = (await fixture()).length;
      pointer("down", 0.5, 0.4);
      await until(
        fixture,
        (text) => text.slice(before).includes("touch-began"),
        "native drag begins before blur",
      );
      pointer("move", 0.5, 0.5);
      window.dispatchEvent(new Event("blur"));
      await until(
        fixture,
        (text) => text.slice(before).includes("touch-ended"),
        "native drag ends on blur",
      );
      const log = (await fixture()).slice(before);
      assert(log.includes("touch-began"), "Native app received the gesture");
      const moves = (await state()).events.filter(
        (event) => event.tag === 3 && event.type === "move",
      ).length;
      await pause(100);
      assert(
        (await state()).events.filter((event) => event.tag === 3 && event.type === "move")
          .length === moves,
        "Cancelled animation frame did not send later drag movement",
      );
      pointer("up", 0.5, 0.5);
    });
    await check(
      "Dashboard controls and reconnecting subscriptions share the control pool",
      async () => {
        const before = await state();
        const themeBefore = button("Theme").getAttribute("aria-checked");
        button("Theme").click();
        await until(
          () => button("Theme").getAttribute("aria-checked"),
          (value) => value !== themeBefore,
          "pooled theme action succeeds",
        );
        await until(
          state,
          (value) => {
            const request = value.events.findLast(
              (event) =>
                event.option === "appearance" && event.at > (before.events.at(-1)?.at ?? 0),
            );
            return (
              !!request &&
              value.events.some(
                (event) =>
                  event.connection === request.connection &&
                  event.requestId === request.requestId &&
                  event.ok === true,
              )
            );
          },
          "native appearance write is acknowledged by server",
        );
        assert(
          (await state()).controlConnections === before.controlConnections,
          "Theme action uses existing control connection",
        );
        const paths = new Set(
          before.events.filter((event) => event.channel === "control").map((event) => event.path),
        );
        assert(
          [...paths].some((path) => path?.startsWith("/metrics")),
          "Real dashboard subscribes to metrics",
        );
        await until(
          state,
          (value) => metricsReceived(value.events),
          "native metrics data arrives on pooled subscription",
        );
        await post("control-drop");
        await until(
          state,
          (value) => value.controlConnections === before.controlConnections + 1,
          "control reconnect",
        );
        await until(
          state,
          (value) =>
            metricsReceived(
              value.events,
              Math.max(
                ...before.events
                  .filter((event) => event.channel === "control")
                  .map((event) => event.connection),
                0,
              ),
            ),
          "metrics resubscribes and receives data on replacement control",
        );
        await advancingVideo();
      },
    );
    await check(
      "Backend restart restores video and native input through the dashboard",
      async () => {
        const previous = window.__hubE2E.peers.at(-1);
        const restartedAt = Date.now();
        await post("restart");
        await until(
          () => window.__hubE2E.peers.at(-1),
          (peer) => !!peer && peer !== previous && peer.connectionState === "connected",
          "replacement WebRTC peer connects after real backend restart",
          45_000,
        );
        await advancingVideo();
        await until(
          state,
          (value) =>
            value.events.some(
              (event) => event.channel === "input" && event.tag === 14 && event.at >= restartedAt,
            ),
          "replacement input socket is admitted",
        );
        await post("launch", { keyboard: true });
        key("KeyZ", "z");
        await until(
          fixture,
          (text) => /text\t\d+\tz\n/.test(text),
          "new native field receives input after restart",
        );
      },
    );
    assert(
      window.__hubE2E.errors.length === 0,
      `Browser errors: ${window.__hubE2E.errors.join("; ")}`,
    );
    window.__hubE2EResult = { ok: true, cases };
  } catch (error) {
    window.__hubE2EResult = {
      ok: false,
      cases,
      error: String(error instanceof Error ? error.stack : error),
    };
  } finally {
    // Retire any held keys or gestures even when a native assertion fails.
    window.dispatchEvent(new Event("blur"));
  }
  await post("result", window.__hubE2EResult);
  return window.__hubE2EResult;
}
