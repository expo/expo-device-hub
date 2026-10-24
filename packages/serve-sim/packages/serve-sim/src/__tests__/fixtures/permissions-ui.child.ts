import { afterEach, expect, mock, test } from "bun:test";
import { createElement } from "react";
import { act, create, type ReactTestRenderer } from "react-test-renderer";

const requests: { action: string; params: any; resolve: (value: any) => void }[] = [];
mock.module("../../socket/client-control", () => ({
  runHostAction: (action: string, params: any) =>
    new Promise((resolve) => requests.push({ action, params, resolve })),
}));
const { AppPermissionsTool } = await import("../../client/components/app-permissions-tool");
const { CollapsibleSection } = await import("../../client/components/collapsible-section");
(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;
let focus: (() => void) | undefined;
(globalThis as any).window = {
  addEventListener(name: string, listener: () => void) {
    if (name === "focus") focus = listener;
  },
  removeEventListener() {
    focus = undefined;
  },
};
let renderer: ReactTestRenderer;
afterEach(async () => {
  await act(async () => renderer?.unmount());
  requests.length = 0;
});
async function mount() {
  await act(async () => {
    renderer = create(createElement(AppPermissionsTool, { udid: "one", bundleId: "app" }));
  });
  await act(async () => renderer.root.findByType(CollapsibleSection).props.onOpenChange(true));
}
function pressed(title: string, label = "Notifications") {
  return renderer.root
    .findByProps({ role: "group", "aria-label": label })
    .findAllByType("button")
    .find((button) => button.props.title === title)!;
}
async function reply(state: string, location?: { Authorization: number } | null) {
  const request = requests.shift()!;
  expect(request.action).toBe("permissions.list");
  await act(async () =>
    request.resolve({
      exitCode: 0,
      stderr: "",
      stdout: JSON.stringify({ permissions: [{ id: "notifications", state }], location }),
    }),
  );
}

test("mount/reload reads stored status and writes use readback rather than ACK", async () => {
  await mount();
  await reply("denied");
  expect(pressed("Deny").props["aria-pressed"]).toBe(true);
  await act(async () => {
    pressed("Allow").props.onClick();
  });
  const write = requests.shift()!;
  expect(write.action).toBe("permissions.set");
  await act(async () => write.resolve({ exitCode: 0, stdout: "ok", stderr: "" }));
  expect(pressed("Allow").props["aria-pressed"]).toBe(false);
  await reply("denied");
  expect(pressed("Deny").props["aria-pressed"]).toBe(true);
  await act(async () => renderer.unmount());
  await mount();
  await reply("granted");
  expect(pressed("Allow").props["aria-pressed"]).toBe(true);
});

test("a read for an old device cannot overwrite a new target", async () => {
  await mount();
  const old = requests.shift()!;
  await act(async () =>
    renderer.update(createElement(AppPermissionsTool, { udid: "two", bundleId: "other" })),
  );
  await act(async () =>
    old.resolve({
      exitCode: 0,
      stderr: "",
      stdout: JSON.stringify({ permissions: [{ id: "notifications", state: "granted" }] }),
    }),
  );
  expect(pressed("Allow").props["aria-pressed"]).toBe(false);
});

test("failed writes stay visible and reset does not display denial", async () => {
  await mount();
  await reply("granted");
  await act(async () => {
    pressed("Reset").props.onClick();
  });
  await act(async () =>
    requests.shift()!.resolve({ exitCode: 1, stdout: "", stderr: "native service unavailable" }),
  );
  await reply("undetermined");
  expect(pressed("Allow").props["aria-pressed"]).toBe(false);
  expect(pressed("Deny").props["aria-pressed"]).toBe(false);
  expect(JSON.stringify(renderer.toJSON())).toContain("native service unavailable");
});

test("background refreshes preserve mutation errors", async () => {
  await mount();
  await reply("denied");
  await act(async () => {
    pressed("Allow").props.onClick();
  });
  await act(async () =>
    requests.shift()!.resolve({ exitCode: 1, stdout: "", stderr: "grant rejected" }),
  );
  await reply("denied");
  await act(async () => focus?.());
  await reply("denied");
  expect(JSON.stringify(renderer.toJSON())).toContain("grant rejected");
  await act(async () => {
    pressed("Reset").props.onClick();
  });
  expect(JSON.stringify(renderer.toJSON())).not.toContain("grant rejected");
});

test("a partial reset failure preserves the error and reads changed service state", async () => {
  await mount();
  await reply("granted");
  await act(async () => {
    renderer.root.findByProps({ title: "serve-sim permissions reset all" }).props.onClick();
  });
  expect(requests[0]!.action).toBe("permissions.resetAll");
  await act(async () =>
    requests.shift()!.resolve({ exitCode: 1, stdout: "", stderr: "one service failed" }),
  );
  await reply("undetermined");
  expect(pressed("Reset").props["aria-pressed"]).toBe(true);
  await act(async () => focus?.());
  await reply("undetermined");
  expect(JSON.stringify(renderer.toJSON())).toContain("one service failed");
});

test("a write for another app does not leave enabled controls silently blocked", async () => {
  await mount();
  await reply("denied");
  await act(async () => {
    pressed("Allow").props.onClick();
  });
  const oldWrite = requests.shift()!;
  await act(async () =>
    renderer.update(createElement(AppPermissionsTool, { udid: "one", bundleId: "other" })),
  );
  expect(requests[0]!.params.bundleId).toBe("other");
  await reply("granted");
  await act(async () => {
    pressed("Deny").props.onClick();
  });
  const newWrite = requests.shift()!;
  expect(newWrite.params.bundleId).toBe("other");
  await act(async () => oldWrite.resolve({ exitCode: 0, stdout: "ok", stderr: "" }));
  expect(pressed("Deny").props.disabled).toBe(true);
  await act(async () => newWrite.resolve({ exitCode: 0, stdout: "ok", stderr: "" }));
  expect(requests[0]!.params.bundleId).toBe("other");
  await reply("denied");
  expect(pressed("Deny").props["aria-pressed"]).toBe(true);
  expect(pressed("Allow").props.disabled).toBe(false);
});

test("returning to an app with an outstanding write keeps it disabled until fresh readback", async () => {
  await mount();
  await reply("denied");
  await act(async () => {
    pressed("Allow").props.onClick();
  });
  const write = requests.shift()!;
  await act(async () =>
    renderer.update(createElement(AppPermissionsTool, { udid: "one", bundleId: "other" })),
  );
  await reply("undetermined");
  await act(async () =>
    renderer.update(createElement(AppPermissionsTool, { udid: "one", bundleId: "app" })),
  );
  expect(pressed("Allow").props.disabled).toBe(true);
  await reply("denied");
  await act(async () => write.resolve({ exitCode: 0, stdout: "ok", stderr: "" }));
  expect(pressed("Allow").props.disabled).toBe(true);
  await reply("granted");
  expect(pressed("Allow").props.disabled).toBe(false);
  expect(pressed("Allow").props["aria-pressed"]).toBe(true);
});

test("an old target's stalled read does not block the new target's focus refresh", async () => {
  await mount();
  const old = requests.shift()!;
  await act(async () =>
    renderer.update(createElement(AppPermissionsTool, { udid: "two", bundleId: "other" })),
  );
  await reply("granted");
  await act(async () => focus?.());
  expect(requests.length).toBe(1);
  expect(requests[0]!.params.bundleId).toBe("other");
  await reply("denied");
  await act(async () =>
    old.resolve({
      exitCode: 0,
      stderr: "",
      stdout: JSON.stringify({ permissions: [{ id: "notifications", state: "granted" }] }),
    }),
  );
  expect(pressed("Deny").props["aria-pressed"]).toBe(true);
});

test("Location Always selects Reset for absent and zero authorization after reload", async () => {
  await mount();
  await reply("undetermined", null);
  expect(pressed("Reset", "Location (Always)").props["aria-pressed"]).toBe(true);
  await act(async () => renderer.unmount());
  await mount();
  await reply("undetermined", { Authorization: 0 });
  expect(pressed("Reset", "Location (Always)").props["aria-pressed"]).toBe(true);
});

test("Location Always distinguishes when-in-use, always and denied authorization", async () => {
  await mount();
  await reply("undetermined", { Authorization: 2 });
  for (const title of ["Allow", "Deny", "Reset"])
    expect(pressed(title, "Location (Always)").props["aria-pressed"]).toBe(false);
  await act(async () => focus?.());
  await reply("undetermined", { Authorization: 4 });
  expect(pressed("Allow", "Location (Always)").props["aria-pressed"]).toBe(true);
  await act(async () => focus?.());
  await reply("undetermined", { Authorization: 1 });
  expect(pressed("Deny", "Location (Always)").props["aria-pressed"]).toBe(true);
});
