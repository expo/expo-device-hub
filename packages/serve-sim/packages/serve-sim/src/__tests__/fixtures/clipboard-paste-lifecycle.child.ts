import { afterEach, expect, mock, test } from "bun:test";
import type { ReactElement } from "react";

const effects: Array<() => void | (() => void)> = [];
const cleanups: Array<() => void> = [];
const react = await import("react");
mock.module("react", () => ({
  ...react,
  useRef: (current: unknown) => ({ current }),
  useCallback: (callback: unknown) => callback,
  useMemo: (factory: () => unknown) => factory(),
  useEffect: (effect: () => void | (() => void)) => effects.push(effect),
}));
type ToastProps = { toast: { status: string }; onPaste?: (text: string) => void };
const toasts = new Map<string, ToastProps>();
mock.module("sonner", () => ({
  toast: {
    custom: (render: () => ReactElement<ToastProps>, options: { id: string }) => {
      toasts.set(options.id, render().props);
    },
    dismiss: (id: string) => { toasts.delete(id); },
  },
}));
mock.module("../../client/components/app-toasts", () => ({ ClipboardToastContent: () => null }));
const { useClipboardToast } = await import("../../client/hooks/use-clipboard-toast");
const pasteToastId = "sim-clipboard-paste";
const previousNavigator = Object.getOwnPropertyDescriptor(globalThis, "navigator");
const previousWindow = Object.getOwnPropertyDescriptor(globalThis, "window");

function deferredRead() {
  let resolve!: (text: string) => void;
  let reject!: (error: Error) => void;
  const result = new Promise<string>((accept, decline) => { resolve = accept; reject = decline; });
  Object.defineProperty(globalThis, "navigator", {
    value: { clipboard: { readText: () => result } },
    configurable: true,
  });
  return { resolve, reject };
}

function mount() {
  const win: { parent?: unknown } = {};
  win.parent = win;
  Object.defineProperty(globalThis, "window", { value: win, configurable: true });
  const sent: string[] = [];
  const clipboard = useClipboardToast("device-a", async () => null, async (text) => {
    sent.push(text);
    return {};
  });
  const active = effects.splice(0).map((effect) => effect()).filter((cleanup) => typeof cleanup === "function");
  let stopped = false;
  const stop = () => {
    if (stopped) return;
    stopped = true;
    for (const cleanup of active) cleanup();
  };
  cleanups.push(stop);
  return { clipboard, sent, stop };
}

afterEach(() => {
  for (const cleanup of cleanups.splice(0)) cleanup();
  effects.length = 0;
  toasts.clear();
  for (const [name, previous] of [["navigator", previousNavigator], ["window", previousWindow]] as const) {
    if (previous) Object.defineProperty(globalThis, name, previous);
    else Reflect.deleteProperty(globalThis, name);
  }
});

test("direct text paste cancels an older toolbar clipboard read", async () => {
  const read = deferredRead();
  const { clipboard, sent } = mount();
  const older = clipboard.pasteFromDevice();
  await clipboard.pasteText("new direct text");
  read.resolve("old toolbar text");
  await older;
  expect(sent).toEqual(["new direct text"]);
});

test("simulator clipboard fallback cancels an older toolbar clipboard read", async () => {
  const read = deferredRead();
  const { clipboard, sent } = mount();
  const older = clipboard.pasteFromDevice();
  clipboard.cancelPaste();
  read.resolve("old toolbar text");
  await older;
  expect(sent).toEqual([]);
  expect(toasts.has(pasteToastId)).toBe(false);
});

test("a rejected clipboard read cannot recreate its fallback after leaving the device", async () => {
  const read = deferredRead();
  const { clipboard, sent, stop } = mount();
  const older = clipboard.pasteFromDevice();
  stop();
  read.reject(new Error("Permission denied"));
  await older;
  expect(toasts.has(pasteToastId)).toBe(false);
  expect(sent).toEqual([]);
});

test("a completed clipboard read cannot paste after leaving the device", async () => {
  const read = deferredRead();
  const { clipboard, sent, stop } = mount();
  const older = clipboard.pasteFromDevice();
  stop();
  read.resolve("text for the retired device");
  await older;
  expect(sent).toEqual([]);
  expect(toasts.has(pasteToastId)).toBe(false);
});

test("leaving the device dismisses manual Paste and invalidates its stored callback", async () => {
  const read = deferredRead();
  const { clipboard, sent, stop } = mount();
  const older = clipboard.pasteFromDevice();
  read.reject(new Error("Permission denied"));
  await older;
  const submit = toasts.get(pasteToastId)?.onPaste;
  expect(submit).toBeFunction();
  stop();
  expect(toasts.has(pasteToastId)).toBe(false);
  submit!("text for the retired device");
  await Promise.resolve();
  expect(sent).toEqual([]);
});

test("a newer paste invalidates a stored manual Paste callback", async () => {
  const read = deferredRead();
  const { clipboard, sent } = mount();
  const older = clipboard.pasteFromDevice();
  read.reject(new Error("Permission denied"));
  await older;
  const submit = toasts.get(pasteToastId)?.onPaste;
  expect(submit).toBeFunction();
  await clipboard.pasteText("newer text");
  submit!("old manual text");
  await Promise.resolve();
  expect(sent).toEqual(["newer text"]);
});
