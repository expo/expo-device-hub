import { afterEach, expect, mock, test } from "bun:test";
import type { ReactElement } from "react";

let cleanup: (() => void) | undefined;
const react = await import("react");
mock.module("react", () => ({
  ...react,
  useRef: (current: unknown) => ({ current }),
  useCallback: (callback: unknown) => callback,
  useMemo: (factory: () => unknown) => factory(),
  useEffect: (effect: () => (() => void)) => { cleanup = effect(); },
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
  const sent: string[] = [];
  const clipboard = useClipboardToast(async (text) => {
    sent.push(text);
    return {};
  });
  return { clipboard, sent, stop: cleanup! };
}

afterEach(() => {
  cleanup?.();
  toasts.clear();
});

test("current clipboard reads paste, while newer pastes invalidate old reads and manual callbacks", async () => {
  const currentRead = deferredRead();
  const { clipboard, sent } = mount();
  const current = clipboard.pasteFromDevice();
  currentRead.resolve("current toolbar text");
  await current;
  expect(sent).toEqual(["current toolbar text"]);
  const read = deferredRead();
  const older = clipboard.pasteFromDevice();
  await clipboard.pasteText("new direct text");
  read.resolve("old toolbar text");
  await older;
  expect(sent).toEqual(["current toolbar text", "new direct text"]);
  const manualRead = deferredRead();
  const manual = clipboard.pasteFromDevice();
  manualRead.reject(new Error("Permission denied"));
  await manual;
  const submit = toasts.get(pasteToastId)?.onPaste;
  expect(submit).toBeFunction();
  await clipboard.pasteText("newer manual replacement");
  submit!("old manual text");
  await Promise.resolve();
  expect(sent).toEqual(["current toolbar text", "new direct text", "newer manual replacement"]);
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

test.each(["resolve", "reject"] as const)("leaving the device cancels a clipboard read that later %ss", async (outcome) => {
  const read = deferredRead();
  const { clipboard, sent, stop } = mount();
  const older = clipboard.pasteFromDevice();
  stop();
  if (outcome === "resolve") read.resolve("text for the retired device");
  else read.reject(new Error("Permission denied"));
  await older;
  expect(sent).toEqual([]);
  expect(toasts.has(pasteToastId)).toBe(false);
});

test("leaving the device dismisses manual Paste and invalidates its callback", async () => {
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
  expect(toasts.has(pasteToastId)).toBe(false);
});
