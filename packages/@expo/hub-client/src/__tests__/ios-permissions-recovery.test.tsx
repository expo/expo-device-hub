import { afterEach, expect, test } from "bun:test";
import { act, create, type ReactTestRenderer } from "react-test-renderer";
import { useAppPermissions } from "../useAppPermissions";
import { iosPermissionTargetId } from "../ios-permissions";
import { type PermissionsBackend } from "../app-permissions";
import { type AppPermission } from "../types";

(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;
let renderer: ReactTestRenderer;
let client: ReturnType<typeof useAppPermissions>;
const rows = (state: AppPermission["state"]): AppPermission[] => [
  { id: "camera", label: "Camera", state },
];
function Harness({
  backend,
  app = "app",
  host = "http://host-a/sim",
}: {
  backend: PermissionsBackend;
  app?: string;
  host?: string;
}) {
  client = useAppPermissions({
    active: true,
    backend,
    appId: app,
    targetId: iosPermissionTargetId(host, "device"),
  });
  return null;
}
afterEach(async () => {
  await act(async () => renderer?.unmount());
});

test("a slow permission reset keeps controls pending through the host deadline and readback", async () => {
  const { runHostAction } = await import("../exec-ws");
  const { iosPermissionsBackend } = await import("../ios-permissions");
  const calls: string[] = [];
  let now = 0;
  const pending: {
    action: string;
    deadline: number;
    resolve: (value: any) => void;
    reject: (error: Error) => void;
  }[] = [];
  const channel = {
    request(body: any, timeout: number) {
      calls.push(body.action);
      if (body.action === "permissions.list")
        return Promise.resolve({
          exitCode: 0,
          stdout: JSON.stringify({ permissions: rows("undetermined") }),
          stderr: "",
        });
      return new Promise((resolve, reject) =>
        pending.push({ action: body.action, deadline: now + timeout, resolve, reject }),
      );
    },
  } as any;
  const backend = iosPermissionsBackend(
    (action, params) =>
      runHostAction("ws://lab/exec-ws", "token", action, params, undefined, channel),
    "device",
  );
  await act(async () => {
    renderer = create(<Harness backend={backend} />);
  });
  await act(async () => client.refreshPermissions());
  await act(async () => client.resetPermissions());
  await act(async () => {
    now = 121_000;
    for (const request of pending)
      if (now >= request.deadline) request.reject(new Error("exec-ws timeout"));
  });
  expect(client.permissionsPending.has("camera")).toBe(true);
  expect(client.permissionsError).toBeNull();
  await act(async () => client.setPermission("camera", "grant"));
  expect(calls).toEqual(["permissions.list", "permissions.resetAll"]);
  await act(async () => pending[0].resolve({ exitCode: 0, stdout: "ok", stderr: "" }));
  expect(calls).toEqual(["permissions.list", "permissions.resetAll", "permissions.list"]);
  expect(client.permissionsPending.size).toBe(0);
});

test("socket loss keeps a reset pending until ordered reconnect readback completes", async () => {
  const { createControlSocket } = await import("../control-socket");
  const { runHostAction } = await import("../exec-ws");
  const { iosPermissionsBackend } = await import("../ios-permissions");
  const sockets: any[] = [];
  const calls: string[] = [];
  let lists = 0;
  let finishRead!: () => void;
  const channel = createControlSocket("ws://lab/exec-ws", "token", {
    openSocket: () => {
      const socket: any = {
        close() {},
        send(raw: string) {
          const body = JSON.parse(raw);
          const reply = (value: any) =>
            queueMicrotask(() => socket.onmessage({ data: JSON.stringify(value) }));
          if (body.token) {
            reply({ ready: true });
            return;
          }
          calls.push(body.action);
          if (body.action === "permissions.list") {
            const send = () =>
              reply({
                id: body.id,
                exitCode: 0,
                stderr: "",
                stdout: JSON.stringify({
                  permissions: rows(lists === 1 ? "granted" : "undetermined"),
                }),
              });
            lists++;
            if (lists === 1) send();
            else finishRead = send;
          }
        },
      };
      sockets.push(socket);
      queueMicrotask(() => socket.onopen());
      return socket;
    },
  });
  const backend = iosPermissionsBackend(
    (action, params) =>
      runHostAction("ws://lab/exec-ws", "token", action, params, undefined, channel),
    "device",
  );
  try {
    await act(async () => {
      renderer = create(<Harness backend={backend} />);
    });
    await act(async () => client.refreshPermissions());
    await act(async () => client.resetPermissions());
    await act(async () => sockets[0].onclose());
    expect(client.permissionsPending.has("camera")).toBe(true);
    await act(async () => client.setPermission("camera", "revoke"));
    expect(calls).toEqual(["permissions.list", "permissions.resetAll", "permissions.list"]);
    await act(async () => finishRead());
    expect(client.permissionsPending.size).toBe(0);
    expect(client.permissions?.[0].state).toBe("undetermined");
    expect(client.permissionsError).toContain("closed");
  } finally {
    channel.dispose();
  }
});
