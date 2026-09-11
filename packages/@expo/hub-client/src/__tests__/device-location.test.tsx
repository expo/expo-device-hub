import { afterEach, expect, test } from "bun:test";
import { act, create, type ReactTestRenderer } from "react-test-renderer";

import { type DeviceLocationRead, useDeviceLocation } from "../useDeviceLocation";

const originals = new Map<string, PropertyDescriptor | undefined>();
function stubGlobal(name: string, value: unknown) {
  originals.set(name, Object.getOwnPropertyDescriptor(globalThis, name));
  Object.defineProperty(globalThis, name, { value, configurable: true, writable: true });
}

let renderer: ReactTestRenderer | undefined;
afterEach(async () => {
  if (renderer) await act(async () => renderer?.unmount());
  renderer = undefined;
  for (const [name, descriptor] of originals) {
    if (descriptor) Object.defineProperty(globalThis, name, descriptor);
    else Reflect.deleteProperty(globalThis, name);
  }
  originals.clear();
});

function stallingBackend() {
  const signals: AbortSignal[] = [];
  let settle: ((read: DeviceLocationRead | null) => void) | undefined;
  const backend = {
    read: (signal: AbortSignal) => {
      signals.push(signal);
      return new Promise<DeviceLocationRead | null>((resolve) => {
        settle = resolve;
      });
    },
    set: () => Promise.reject(new Error("not used")),
  };
  return { backend, signals, settle: (read: DeviceLocationRead | null) => settle?.(read) };
}

function captureRetryTimer() {
  const ticks: Array<() => void> = [];
  stubGlobal("setInterval", (callback: () => void) => {
    ticks.push(callback);
    return ticks.length;
  });
  stubGlobal("clearInterval", () => {});
  return ticks;
}

async function mount(backend: Parameters<typeof useDeviceLocation>[0]) {
  stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  let client: ReturnType<typeof useDeviceLocation> | undefined;
  function Harness() {
    client = useDeviceLocation(backend);
    return null;
  }
  await act(async () => {
    renderer = create(<Harness />);
  });
  return () => client!;
}

test("a retry tick does not start a second read while the first is in flight", async () => {
  const ticks = captureRetryTimer();
  const { backend, signals, settle } = stallingBackend();
  const client = await mount(backend);

  expect(signals).toHaveLength(1);
  for (let i = 0; i < 3; i++) await act(async () => ticks[0]!());
  expect(signals).toHaveLength(1);

  await act(async () => settle({ supported: true, location: { latitude: 1, longitude: 2 } }));
  expect(client().location).toEqual({ latitude: 1, longitude: 2 });
});

test("a settled read lets the next retry tick read again", async () => {
  const ticks = captureRetryTimer();
  const { backend, signals, settle } = stallingBackend();
  await mount(backend);

  await act(async () => settle(null));
  await act(async () => ticks[0]!());
  expect(signals).toHaveLength(2);
});

test("unmounting aborts the in-flight read", async () => {
  captureRetryTimer();
  const { backend, signals } = stallingBackend();
  await mount(backend);

  expect(signals[0]!.aborted).toBe(false);
  await act(async () => renderer?.unmount());
  renderer = undefined;
  expect(signals[0]!.aborted).toBe(true);
});
