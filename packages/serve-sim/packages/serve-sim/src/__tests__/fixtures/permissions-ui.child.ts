import { afterEach, expect, mock, spyOn, test } from "bun:test";
import { createElement } from "react";
import { act, create, type ReactTestRenderer } from "react-test-renderer";
import type { ExecResult, runHostAction } from "../../socket/client-control";

type ActionArgs = Parameters<typeof runHostAction>;
type Request = {
  action: string;
  params: ActionArgs[1];
  resolve: (value: ExecResult) => void;
};

const requests: Request[] = [];
mock.module("../../socket/client-control", () => ({
  runHostAction: (action: string, params: ActionArgs[1], options: ActionArgs[2]) =>
    new Promise<ExecResult>((resolve, reject) => {
      const signal = options?.signal;
      const abort = () => reject(signal?.reason);
      signal?.addEventListener("abort", abort, { once: true });
      requests.push({
        action,
        params,
        resolve(result) {
          signal?.removeEventListener("abort", abort);
          resolve(result);
        },
      });
    }),
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
  await setOpen(true);
}

const setOpen = (open: boolean) =>
  act(async () => renderer.root.findByType(CollapsibleSection).props.onOpenChange(open));
const selectApp = (bundleId: string, udid = "one") =>
  act(async () => renderer.update(createElement(AppPermissionsTool, { udid, bundleId })));

function button(title: string, label = "Notifications") {
  return renderer.root
    .findByProps({ role: "group", "aria-label": label })
    .findAllByType("button")
    .find((button) => button.props.title === title)!;
}
const click = (title: string) =>
  act(async () => {
    button(title).props.onClick();
  });
const focusWindow = () => act(async () => focus?.());
const view = () => JSON.stringify(renderer.toJSON());

function respond(request: Request, result: Partial<ExecResult> = {}) {
  return act(async () => request.resolve({ exitCode: 0, stdout: "", stderr: "", ...result }));
}

function takeRead() {
  const request = requests.shift();
  expect(request?.action).toBe("permissions.list");
  return request!;
}

function reply(state: string, location?: { Authorization: number } | null, request = takeRead()) {
  return respond(request, {
    stdout: JSON.stringify({ permissions: [{ id: "notifications", state }], location }),
  });
}

function fail(stderr: string, request = requests.shift()!) {
  return respond(request, { exitCode: 1, stderr });
}

test("opening, reloading and changing a permission use the Simulator's reported state", async () => {
  await mount();
  await reply("denied");
  expect(button("Deny").props["aria-pressed"]).toBe(true);
  await click("Allow");
  const write = requests.shift()!;
  expect(write.action).toBe("permissions.set");
  await respond(write);
  expect(button("Allow").props["aria-pressed"]).toBe(false);
  await reply("denied");
  expect(button("Deny").props["aria-pressed"]).toBe(true);
  await act(async () => renderer.unmount());
  await mount();
  await reply("granted");
  expect(button("Allow").props["aria-pressed"]).toBe(true);
});

test("failed writes stay visible and reset does not display denial", async () => {
  await mount();
  await reply("granted");
  await click("Reset");
  await fail("native service unavailable");
  await reply("undetermined");
  expect(button("Allow").props["aria-pressed"]).toBe(false);
  expect(button("Deny").props["aria-pressed"]).toBe(false);
  expect(view()).toContain("native service unavailable");
});

test("background refreshes preserve mutation errors", async () => {
  await mount();
  await reply("denied");
  await click("Allow");
  await fail("grant rejected");
  await reply("denied");
  await focusWindow();
  await reply("denied");
  expect(view()).toContain("grant rejected");
  await click("Reset");
  expect(view()).not.toContain("grant rejected");
});

test("a partial reset failure preserves the error and reads changed service state", async () => {
  await mount();
  await reply("granted");
  await act(async () => {
    renderer.root.findByProps({ title: "serve-sim permissions reset all" }).props.onClick();
  });
  expect(requests[0]!.action).toBe("permissions.resetAll");
  await fail("one service failed");
  await reply("undetermined");
  expect(button("Reset").props["aria-pressed"]).toBe(true);
  await focusWindow();
  await reply("undetermined");
  expect(view()).toContain("one service failed");
});

test("a write for another app does not leave enabled controls silently blocked", async () => {
  await mount();
  await reply("denied");
  await click("Allow");
  const oldWrite = requests.shift()!;
  await selectApp("other");
  expect(requests[0]!.params?.bundleId).toBe("other");
  await reply("granted");
  await click("Deny");
  const newWrite = requests.shift()!;
  expect(newWrite.params?.bundleId).toBe("other");
  await respond(oldWrite);
  expect(button("Deny").props.disabled).toBe(true);
  await respond(newWrite);
  expect(requests[0]!.params?.bundleId).toBe("other");
  await reply("denied");
  expect(button("Deny").props["aria-pressed"]).toBe(true);
  expect(button("Allow").props.disabled).toBe(false);
});

test("returning to an app with an outstanding write keeps it disabled until fresh readback", async () => {
  await mount();
  await reply("denied");
  await click("Allow");
  const write = requests.shift()!;
  await selectApp("other");
  await reply("undetermined");
  await selectApp("app");
  expect(button("Allow").props.disabled).toBe(true);
  expect(requests).toHaveLength(0);
  await respond(write);
  expect(button("Allow").props.disabled).toBe(true);
  await reply("granted");
  expect(button("Allow").props.disabled).toBe(false);
  expect(button("Allow").props["aria-pressed"]).toBe(true);
});

test("an old target's stalled read does not block the new target's focus refresh", async () => {
  await mount();
  const old = takeRead();
  await selectApp("other", "two");
  await reply("granted");
  await focusWindow();
  expect(requests.length).toBe(1);
  expect(requests[0]!.params?.bundleId).toBe("other");
  await reply("denied");
  await reply("granted", undefined, old);
  expect(button("Deny").props["aria-pressed"]).toBe(true);
});

test("Location Always selects Reset for absent and zero authorization after reload", async () => {
  await mount();
  await reply("undetermined", null);
  expect(button("Reset", "Location (Always)").props["aria-pressed"]).toBe(true);
  await act(async () => renderer.unmount());
  await mount();
  await reply("undetermined", { Authorization: 0 });
  expect(button("Reset", "Location (Always)").props["aria-pressed"]).toBe(true);
});

test("Location Always distinguishes when-in-use, always and denied authorization", async () => {
  await mount();
  await reply("undetermined", { Authorization: 2 });
  for (const title of ["Allow", "Deny", "Reset"])
    expect(button(title, "Location (Always)").props["aria-pressed"]).toBe(false);
  await focusWindow();
  await reply("undetermined", { Authorization: 4 });
  expect(button("Allow", "Location (Always)").props["aria-pressed"]).toBe(true);
  await focusWindow();
  await reply("undetermined", { Authorization: 1 });
  expect(button("Deny", "Location (Always)").props["aria-pressed"]).toBe(true);
});

test("retains a mutation failure received while the permission section is collapsed", async () => {
  await mount();
  await reply("denied");
  await click("Allow");
  const write = requests.shift()!;
  await setOpen(false);
  await fail("grant rejected while collapsed", write);
  await reply("denied");
  expect(view()).toContain("grant rejected while collapsed");
  await setOpen(true);
  await reply("denied");
  expect(view()).toContain("grant rejected while collapsed");
});

test("retains an already-visible mutation failure after collapse and reopen", async () => {
  await mount();
  await reply("denied");
  await click("Allow");
  await fail("grant rejected before collapse");
  await reply("denied");
  expect(view()).toContain("grant rejected before collapse");
  await setOpen(false);
  await setOpen(true);
  await reply("denied");
  expect(view()).toContain("grant rejected before collapse");
});

test("a target change clears the previous app's mutation error", async () => {
  await mount();
  await reply("denied");
  await click("Allow");
  await fail("old app grant failed");
  await reply("denied");
  expect(view()).toContain("old app grant failed");
  await selectApp("other");
  await reply("undetermined");
  expect(view()).not.toContain("old app grant failed");
});

test("a failed permission read keeps the last rows until a refresh succeeds", async () => {
  await mount();
  await reply("granted");
  await focusWindow();
  await fail("permission read failed");
  expect(view()).toContain("permission read failed");
  expect(button("Allow").props["aria-pressed"]).toBe(true);
  await focusWindow();
  await reply("denied");
  expect(button("Deny").props["aria-pressed"]).toBe(true);
  expect(view()).not.toContain("permission read failed");
});

test.each(["list failed", "list timed out"])(
  "immediate readback error '%s' keeps a write pending until a poll succeeds",
  async (readError) => {
    const interval = spyOn(globalThis, "setInterval");
    const deadline = new AbortController();
    const timeout = spyOn(AbortSignal, "timeout");
    try {
      await mount();
      const [poll] = interval.mock.calls.find(([, delay]) => delay === 5_000)!;
      await reply("denied");
      await click("Allow");

      timeout.mockClear();
      timeout.mockReturnValueOnce(deadline.signal);
      await fail("grant failed");
      const readback = takeRead();
      expect(timeout.mock.calls).toEqual([[135_000]]);
      await act(async () => poll());
      expect(requests).toHaveLength(0);

      if (readError === "list timed out") {
        await act(async () => deadline.abort(new DOMException(readError, "TimeoutError")));
      } else {
        await fail(readError, readback);
      }
      expect(button("Allow").props.disabled).toBe(true);
      expect(view()).toContain(`grant failed. Readback: ${readError}`);

      await act(async () => poll());
      await reply("denied");
      expect(button("Allow").props.disabled).toBe(false);
      expect(view()).toContain("grant failed");
      expect(view()).not.toContain(readError);
    } finally {
      interval.mockRestore();
      timeout.mockRestore();
    }
  },
);

test("a failed old-target read cannot clear the new app's confirmed rows", async () => {
  await mount();
  const oldRead = requests.shift()!;
  await selectApp("other", "two");
  await reply("granted");
  await fail("old target read failed", oldRead);
  expect(button("Allow").props["aria-pressed"]).toBe(true);
  expect(view()).not.toContain("old target read failed");
});
