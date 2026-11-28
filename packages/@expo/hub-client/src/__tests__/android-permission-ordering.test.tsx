import { expect, test } from "bun:test";
import { act, create, type ReactTestRenderer } from "react-test-renderer";
import { androidPermissionsBackend } from "../android-permissions";
import { useAppPermissions } from "../useAppPermissions";
import type { ExecClock } from "../../../../serve-emu/packages/serve-emu/src/exec";
// Exercise the shipped client and queue together; fetch models only routing. Load serve-emu by URL
// because its explicit .ts imports use a different tsconfig from this browser package.
const { createPermissionRequestQueue } = await import(
  new URL("../../../../serve-emu/packages/serve-emu/src/permission-requests.ts", import.meta.url)
    .href
);

const { grantPermission, revokePermission } = await import(
  new URL("../../../../serve-emu/packages/serve-emu/src/app-management.ts", import.meta.url).href
);
const { listPermissions } = await import(
  new URL("../../../../serve-emu/packages/serve-emu/src/app-permissions.ts", import.meta.url).href
);

(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;
type Timer = { callback: () => void; due: number };
class ManualClock implements ExecClock {
  nowMs = 0;
  timers = new Set<Timer>();
  now() {
    return this.nowMs;
  }
  setTimeout(callback: () => void, delayMs: number) {
    const timer = { callback, due: this.nowMs + delayMs };
    this.timers.add(timer);
    return timer;
  }
  clearTimeout(timer: unknown) {
    this.timers.delete(timer as Timer);
  }
  advance(ms: number) {
    this.nowMs += ms;
    for (const timer of this.timers) {
      if (timer.due > this.nowMs) continue;
      this.timers.delete(timer);
      timer.callback();
    }
  }
}
function gate() {
  let release!: () => void;
  const promise = new Promise<void>((resolve) => {
    release = resolve;
  });
  return { promise, release };
}

test("an Android write readback waits behind another slow write without a residual error", async () => {
  const clock = new ManualClock();
  const run = createPermissionRequestQueue(clock);
  const camera = gate();
  const microphone = gate();
  const granted = new Map([
    ["android.permission.CAMERA", false],
    ["android.permission.RECORD_AUDIO", true],
  ]);
  let micStarted = false;
  let reads = 0;
  const pkg = "com.example.app";
  const dependencies = {
    runPermissionRequest: run,
    execText: async (_cmd: string, args: string[]) => {
      let stdout = "";
      if (args[3] === "dumpsys") {
        stdout =
          "runtime permissions:\n" +
          [...granted].map(([name, value]) => `  ${name}: granted=${value}, flags=[]`).join("\n");
      } else {
        const permission = args[6]!;
        if (permission === "android.permission.CAMERA") await camera.promise;
        else {
          micStarted = true;
          await microphone.promise;
        }
        granted.set(permission, args[4] === "grant");
      }
      return { status: 0, signal: null, stdout, stderr: "", timedOut: false, error: null };
    },
  };
  const backend = androidPermissionsBackend("http://host/emu", "device", async (input, init) => {
    try {
      if (init?.method === "POST") {
        const body = JSON.parse(init.body as string);
        const action = new URL(input).pathname.endsWith("/grant")
          ? grantPermission
          : revokePermission;
        return Response.json(
          await action("device", body.packageName, body.permission, dependencies),
        );
      }
      reads++;
      return Response.json(await listPermissions("device", pkg, dependencies));
    } catch (error) {
      return Response.json({ ok: false, error: (error as Error).message }, { status: 400 });
    }
  });
  let client!: ReturnType<typeof useAppPermissions>;
  function Harness() {
    client = useAppPermissions({ active: true, appId: pkg, backend, targetId: "device" });
    return null;
  }
  let renderer!: ReactTestRenderer;
  try {
    await act(async () => {
      renderer = create(<Harness />);
    });
    await act(async () => client.refreshPermissions());
    await act(async () => client.setPermission("android.permission.CAMERA", "grant"));
    await act(async () => client.setPermission("android.permission.RECORD_AUDIO", "revoke"));
    await act(async () => camera.release());
    expect(micStarted).toBe(true);
    expect(reads).toBe(2); // Initial list and Camera's post-write list, queued behind Microphone.
    await act(async () => clock.advance(10_001));
    expect(client.permissionsError).toBeNull();
    expect(client.permissionsPending.size).toBe(2);
    await act(async () => microphone.release());
    expect(client.permissionsPending.size).toBe(0);
    expect(client.permissions?.map((row) => row.state)).toEqual(["granted", "denied"]);
    expect(client.permissionsError).toBeNull();
    await act(async () => client.refreshPermissions());
    expect(client.permissionsError).toBeNull();
  } finally {
    await act(async () => {
      camera.release();
      microphone.release();
    });
    await act(async () => renderer?.unmount());
  }
});
