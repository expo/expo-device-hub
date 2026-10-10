import { afterEach, expect, mock, test } from "bun:test";
import type { ReactElement } from "react";

const cleanups: (() => void)[] = [];
const react = await import("react");
mock.module("react", () => ({
  ...react,
  useRef: (current: unknown) => ({ current }),
  useCallback: (callback: unknown) => callback,
  useMemo: (factory: () => unknown) => factory(),
  useEffect: (effect: () => (() => void) | void) => {
    const cleanup = effect();
    if (cleanup) cleanups.push(cleanup);
  },
}));
type ToastProps = { toast: { status: string; message: string }; onCopy?: () => void; onPaste?: (text: string) => void };
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
const { SimClipboardCopyError } = await import("../../client/utils/sim-clipboard");
const pasteToastId = "sim-clipboard-paste";
const win: { parent?: unknown } = {};
win.parent = win;
Object.defineProperty(globalThis, "window", { value: win, configurable: true });

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

function unmount() {
  for (const cleanup of cleanups.splice(0)) cleanup();
}

function mount(readCopy: () => Promise<{ text: string } | null> = async () => null) {
  const sent: string[] = [];
  const clipboard = useClipboardToast("device-a", readCopy, async (text) => {
    sent.push(text);
    return {};
  });
  return { clipboard, sent, stop: unmount };
}

afterEach(() => {
  unmount();
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

test("denied browser writes offer manual Copy, and a throwing fallback reports failure", async () => {
  Object.defineProperty(globalThis, "navigator", {
    value: { clipboard: { writeText: async () => { throw new Error("Permission denied"); } } },
    configurable: true,
  });
  let removed = false;
  Object.defineProperty(globalThis, "document", {
    value: {
      createElement: () => ({
        style: {}, setAttribute() {}, select() {}, setSelectionRange() {},
        remove() { removed = true; },
      }),
      body: { appendChild() {} },
      execCommand: () => { throw new Error("Copy denied"); },
    },
    configurable: true,
  });
  try {
    const { clipboard } = mount(async () => ({ text: "selected text" }));
    await clipboard.copyFromSim();
    const manual = toasts.get("sim-clipboard-manual");
    expect(manual?.toast.status).toBe("manual");
    expect(() => manual!.onCopy!()).not.toThrow();
    expect(removed).toBe(true);
    expect(toasts.get("sim-clipboard-manual")?.toast).toEqual({ status: "error", message: "Copy failed" });
  } finally {
    Reflect.deleteProperty(globalThis, "document");
  }
});

test.each([false, true])("empty Copy clears the browser clipboard (write denied: %s)", async (denied) => {
  const written: string[] = [];
  Object.defineProperty(globalThis, "navigator", {
    value: { clipboard: { writeText: async (text: string) => {
      written.push(text);
      if (denied) throw new Error("Permission denied");
    } } },
    configurable: true,
  });
  const { clipboard } = mount(async () => ({ text: "" }));
  await clipboard.copyFromSim();
  expect(written).toEqual([""]);
  expect(toasts.get("sim-clipboard-copy")?.toast).toEqual({
    status: denied ? "error" : "success",
    message: denied
      ? "Simulator clipboard is empty. The browser clipboard still has older text"
      : "Simulator clipboard is empty",
  });
  expect(toasts.has("sim-clipboard-manual")).toBe(false);
});

type Policy = { allowsFeature(feature: string): boolean };
const allowsAll: Policy = { allowsFeature: () => true };

/**
 * A framed page. With `afterRequest`, this page asked the embedding page for clipboard-read before this load.
 * A null `policy` is a browser without a policy API. Returns the messages posted to the embedding page and a restore.
 */
function framed(
  navigatorValue: object,
  { afterRequest = true, policy = allowsAll }: { afterRequest?: boolean; policy?: Policy | null } = {},
): { posted: unknown[]; restore: () => void } {
  const posted: unknown[] = [];
  const stored = new Map(afterRequest ? [["serve-sim:frame-permission-requested:clipboard-read", "1"]] : []);
  Object.defineProperty(globalThis, "window", {
    value: {
      parent: { postMessage: (message: unknown) => posted.push(message) },
      sessionStorage: {
        getItem: (key: string) => stored.get(key) ?? null,
        setItem: (key: string, value: string) => stored.set(key, value),
        removeItem: (key: string) => stored.delete(key),
      },
    },
    configurable: true,
  });
  Object.defineProperty(globalThis, "document", {
    value: policy ? { permissionsPolicy: policy } : {},
    configurable: true,
  });
  Object.defineProperty(globalThis, "navigator", { value: navigatorValue, configurable: true });
  return {
    posted,
    restore: () => {
      Object.defineProperty(globalThis, "window", { value: win, configurable: true });
      Reflect.deleteProperty(globalThis, "document");
    },
  };
}

test.each([
  ["allows it", "prompt", allowsAll, { status: "success", message: "Clipboard allowed. Paste again" }],
  ["allows it", "denied", allowsAll, undefined],
  ["cannot be read", "prompt", null, { status: "info", message: "Paste again" }],
  ["cannot be read", "denied", null, undefined],
] as const)(
  "the first load after a frame request announces Paste only when the browser may allow it (policy %s, browser %s)",
  async (_, state, policy, announced) => {
    const { restore } = framed({ permissions: { query: async () => ({ state }) } }, { policy });
    try {
      mount();
      await Bun.sleep(5);
      expect(toasts.get(pasteToastId)?.toast).toEqual(announced);
    } finally {
      restore();
    }
  },
);

test("a Paste that starts during the grant check keeps its manual field", async () => {
  let answer!: (status: { state: string }) => void;
  const { restore } = framed({
    permissions: { query: () => new Promise((resolve) => { answer = resolve; }) },
    clipboard: { readText: async () => { throw new Error("Permission denied"); } },
  });
  try {
    const { clipboard } = mount();
    await Bun.sleep(5);
    await clipboard.pasteFromDevice();
    expect(toasts.get(pasteToastId)?.toast.status).toBe("paste");
    answer({ state: "prompt" });
    await Bun.sleep(5);
    expect(toasts.get(pasteToastId)?.toast.status).toBe("paste");
  } finally {
    restore();
  }
});

test.each([[true, 1], [false, 0]] as const)(
  "a failed framed Paste asks the embedding page only when the browser has readText (has readText: %p)",
  async (hasReadText, requests) => {
    const clipboard = hasReadText ? { readText: async () => { throw new Error("Permission denied"); } } : {};
    const { posted, restore } = framed({ clipboard }, { afterRequest: false, policy: { allowsFeature: () => false } });
    try {
      await mount().clipboard.pasteFromDevice();
      expect(toasts.get(pasteToastId)?.toast.status).toBe("paste");
      expect(posted).toHaveLength(requests);
    } finally {
      restore();
    }
  },
);

test("leaving the device cancels a pending Copy before it writes to the browser", async () => {
  const written: string[] = [];
  Object.defineProperty(globalThis, "navigator", {
    value: { clipboard: { writeText: async (text: string) => { written.push(text); } } },
    configurable: true,
  });
  let resolve!: (result: { text: string }) => void;
  const read = new Promise<{ text: string }>((accept) => { resolve = accept; });
  const { clipboard, stop } = mount(() => read);
  const copy = clipboard.copyFromSim();
  stop();
  resolve({ text: "retired text" });
  await copy;
  expect(written).toEqual([]);
  expect(toasts.has("sim-clipboard-copy")).toBe(false);
});

test("failed Copy shows its key cleanup warning beside the error", async () => {
  const { clipboard } = mount(async () => {
    throw new SimClipboardCopyError("No change", "A key may still be held");
  });
  await clipboard.copyFromSim();
  expect(toasts.get("sim-clipboard-copy")?.toast).toEqual({ status: "error", message: "No change" });
  expect(toasts.get("sim-clipboard-key-cleanup")?.toast).toEqual({ status: "error", message: "A key may still be held" });
});
