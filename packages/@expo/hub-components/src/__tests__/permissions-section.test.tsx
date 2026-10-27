import { afterEach, expect, spyOn, test } from "bun:test";
import { act, create, type ReactTestRenderer } from "react-test-renderer";
import type { DeviceClient } from "@expo/hub-client";
import { useAppPermissions } from "../../../hub-client/src/useAppPermissions";
import type { PermissionsBackend } from "../../../hub-client/src/app-permissions";
import { PermissionsSection } from "../dashboard/PermissionsSection";
import { Button } from "../primitives";

(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;
let renderer: ReactTestRenderer | undefined;
const oldWindow = globalThis.window;
let restoreTimers: (() => void) | undefined;
let client: ReturnType<typeof useAppPermissions>;
const focusListeners = new Set<() => void>();

afterEach(async () => {
  await act(async () => renderer?.unmount());
  renderer = undefined;
  restoreTimers?.();
  restoreTimers = undefined;
  globalThis.window = oldWindow;
});

function stubWindow() {
  focusListeners.clear();
  globalThis.window = {
    addEventListener: (name: string, listener: () => void) => {
      if (name === "focus") focusListeners.add(listener);
    },
    removeEventListener: (name: string, listener: () => void) => {
      if (name === "focus") focusListeners.delete(listener);
    },
    matchMedia: () => ({ matches: true, addEventListener() {}, removeEventListener() {} }),
  } as unknown as Window & typeof globalThis;
}

function Harness({ backend }: { backend: PermissionsBackend }) {
  client = useAppPermissions({ active: true, appId: "app", targetId: "android", backend });
  const device = {
    ...client,
    platform: "android",
    foregroundApp: { id: "app" },
  } as DeviceClient;
  return <PermissionsSection client={device} defaultOpen />;
}

test("Retry recovers a failed Android write and readback without releasing ownership early", async () => {
  stubWindow();
  let reads = 0;
  const backend: PermissionsBackend = {
    list: async () => {
      if (++reads === 2) throw new Error("read disconnected");
      return [{ id: "camera", label: "Camera", state: reads === 1 ? "granted" : "denied" }];
    },
    write: async () => {
      throw new Error("write disconnected");
    },
    reset: async () => [],
  };
  await act(async () => {
    renderer = create(<Harness backend={backend} />);
  });
  await act(async () => client.setPermission("camera", "revoke"));
  expect(reads).toBe(2);
  expect(client.permissionsPending.has("camera")).toBe(true);
  const retry = renderer!.root
    .findAllByType(Button)
    .find((button) => button.props.children === "Retry");
  expect(retry).toBeDefined();
  expect(retry!.props.disabled).not.toBe(true);
  await act(async () => retry!.props.onClick());
  expect(client.permissionsPending.size).toBe(0);
  expect(client.permissions?.[0].state).toBe("denied");
  expect(client.permissionsError).toBe("write disconnected");
});

test.each(["ios", "android"] as const)(
  "%s refreshes on interval and focus only while its section is open",
  async (platform) => {
    stubWindow();
    const timers = new Map<number, () => void>();
    let timerId = 0;
    const interval = spyOn(globalThis, "setInterval").mockImplementation(((
      callback: () => void,
    ) => {
      timers.set(++timerId, callback);
      return timerId;
    }) as typeof setInterval);
    const clear = spyOn(globalThis, "clearInterval").mockImplementation(((id: number) =>
      timers.delete(id)) as typeof clearInterval);
    restoreTimers = () => {
      interval.mockRestore();
      clear.mockRestore();
    };
    let reads = 0;
    const device = {
      platform,
      foregroundApp: { id: "app" },
      permissions: [],
      permissionsPending: new Set(),
      permissionsError: null,
      refreshPermissions: () => {
        reads++;
      },
    } as unknown as DeviceClient;
    await act(async () => {
      renderer = create(<PermissionsSection client={device} />);
    });
    expect(reads).toBe(0);
    expect(timers.size).toBe(0);
    expect(focusListeners.size).toBe(0);
    const toggle = () =>
      renderer!.root
        .findAllByType("button")
        .find((button) => "aria-expanded" in button.props)!
        .props.onClick();
    await act(async () => toggle());
    expect(reads).toBe(1);
    expect(timers.size).toBe(1);
    expect(focusListeners.size).toBe(1);
    await act(async () => {
      for (const tick of timers.values()) tick();
    });
    expect(reads).toBe(2);
    await act(async () => {
      for (const focus of focusListeners) focus();
    });
    expect(reads).toBe(3);
    await act(async () => toggle());
    expect(timers.size).toBe(0);
    expect(focusListeners.size).toBe(0);
  },
);
