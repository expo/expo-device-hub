import { afterEach, describe, expect, test } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";
import { act, create, type ReactTestInstance, type ReactTestRenderer } from "react-test-renderer";

import { type DeviceClient, type KeychainWriteResult } from "@expo/hub-client";
import { Button } from "../components/Button";
import { describeKeychainWrite, parseKeychainDraft } from "../dashboard/keychainInput";
import { KeychainSection } from "../dashboard/KeychainSection";
import { createGlobalStubs } from "./test-globals";

const { stubGlobal, restoreGlobals } = createGlobalStubs();
const APP = "com.example.app";

let renderer: ReactTestRenderer | undefined;
afterEach(async () => {
  if (renderer) await act(async () => renderer?.unmount());
  renderer = undefined;
  restoreGlobals();
});

type Calls = Array<{ fn: string; appId: string; arg?: unknown; options?: unknown }>;

function keychainClient(overrides: Partial<DeviceClient> = {}, keys: string[] = []) {
  const calls: Calls = [];
  const applied = (names: string[]): KeychainWriteResult => ({
    applied: true,
    keys: names.map((key) => ({ key, status: 0, ok: true, message: "ok" })),
  });
  const client = {
    capabilities: { keychain: true },
    foregroundApp: { id: APP },
    listKeychainKeys: async (appId: string, options?: unknown) => {
      calls.push({ fn: "list", appId, options });
      return keys;
    },
    setKeychainValues: async (appId: string, values: Record<string, string>, options?: unknown) => {
      calls.push({ fn: "set", appId, arg: values, options });
      return applied(Object.keys(values));
    },
    deleteKeychainValues: async (appId: string, names: readonly string[], options?: unknown) => {
      calls.push({ fn: "delete", appId, arg: names, options });
      return applied([...names]);
    },
    ...overrides,
  } as unknown as DeviceClient;
  return { client, calls };
}

async function setup(client: DeviceClient) {
  stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  stubGlobal("window", { setTimeout, clearTimeout });
  await act(async () => {
    renderer = create(<KeychainSection client={client} defaultOpen />);
  });
  const root = renderer!.root;
  const button = (label: string) =>
    root.findAllByType(Button).find((node: ReactTestInstance) => node.props.children === label);
  const text = () => JSON.stringify(renderer!.toJSON());
  return {
    button,
    text,
    field: (label: string) => root.findByProps({ "aria-label": label }),
    click: (label: string) => act(async () => button(label)!.props.onClick()),
    type: (label: string, value: string) =>
      act(async () =>
        root.findByProps({ "aria-label": label }).props.onChange({ currentTarget: { value } }),
      ),
    rerender: (next: DeviceClient) =>
      act(async () => renderer!.update(<KeychainSection client={next} defaultOpen />)),
  };
}

test("asks for a foreground app before anything else, and treats the home screen as none", () => {
  for (const foregroundApp of [null, { id: "com.apple.springboard" }]) {
    const { client } = keychainClient({ foregroundApp });
    expect(renderToStaticMarkup(<KeychainSection client={client} defaultOpen />)).toContain(
      "No app is in the foreground.",
    );
  }
});

test("offers no controls for a system app, which serve-sim cannot reach", () => {
  const { client, calls } = keychainClient({ foregroundApp: { id: "com.apple.mobilesafari" } });
  const html = renderToStaticMarkup(<KeychainSection client={client} defaultOpen />);
  expect(html).toContain(
    "com.apple.mobilesafari is a system app. Keychain works in user apps only.",
  );
  expect(html).not.toContain("Keychain key");
  expect(calls).toEqual([]);
});

test("lists the app's keys with a Delete button each", async () => {
  const { client, calls } = keychainClient({}, ["accessToken", "refreshToken"]);
  const s = await setup(client);
  expect(calls).toEqual([{ fn: "list", appId: APP, options: {} }]);
  expect(s.text()).toContain("accessToken");
  expect(s.text()).toContain("refreshToken");
  // A service typed after the list does not redirect the Delete.
  await s.type("Keychain service", "auth");
  expect(s.button("Delete")!.props.ariaLabel).toBe("Delete accessToken");
  await s.click("Delete");
  expect(calls.find((call) => call.fn === "delete")).toEqual({
    fn: "delete",
    appId: APP,
    arg: ["accessToken"],
    options: {},
  });
  expect(s.text()).toContain("Deleted accessToken in com.example.app.");
});

test("sets one key, clears the form, and reads the keys again", async () => {
  const { client, calls } = keychainClient();
  const s = await setup(client);
  await s.type("Keychain key", "accessToken");
  await s.type("Keychain value", "tok");
  await s.type("Keychain service", "auth");
  await s.click("Set");
  expect(calls.find((call) => call.fn === "set")).toEqual({
    fn: "set",
    appId: APP,
    arg: { accessToken: "tok" },
    options: { service: "auth", relaunch: false },
  });
  expect(s.text()).toContain("Set accessToken in com.example.app.");
  // The keys are read again where the value went.
  expect(calls.filter((call) => call.fn === "list").at(-1)).toEqual({
    fn: "list",
    appId: APP,
    options: { service: "auth" },
  });
  expect(s.text()).not.toContain('"tok"');
});

test("sets every key of a pasted JSON object", async () => {
  const { client, calls } = keychainClient();
  const s = await setup(client);
  await s.type("Keychain value", '{"a":"1","b":"2"}');
  await s.click("Set");
  expect(calls.find((call) => call.fn === "set")?.arg).toEqual({ a: "1", b: "2" });
  expect(s.text()).toContain("Set 2 keys in com.example.app.");
});

test("keeps the result of a relaunch while the foreground app changes", async () => {
  let finish: (result: KeychainWriteResult) => void = () => {};
  const { client, calls } = keychainClient({
    setKeychainValues: (appId, values, options) => {
      calls.push({ fn: "set", appId, arg: values, options });
      return new Promise((resolve) => (finish = resolve));
    },
  });
  const s = await setup(client);
  await s.type("Keychain key", "accessToken");
  await s.type("Keychain value", "tok");
  await s.click("Set and relaunch");
  expect(s.text()).toContain("Setting and restarting the app…");
  expect(s.field("Keychain value").props.disabled).toBe(true);
  await s.rerender({ ...client, foregroundApp: { id: "com.apple.springboard" } } as DeviceClient);
  await act(async () =>
    finish({ applied: true, keys: [{ key: "accessToken", status: 0, ok: true, message: "ok" }] }),
  );
  expect(calls.find((call) => call.fn === "set")).toMatchObject({
    appId: APP,
    options: { relaunch: true },
  });
  // The home screen has no keychain of its own, so nothing listed it.
  expect(calls.filter((call) => call.appId !== APP)).toEqual([]);
  expect(s.text()).toContain("Set accessToken in com.example.app. The app restarted.");
});

test("explains a write the app applies at its next start", async () => {
  const { client } = keychainClient(
    {
      setKeychainValues: async () => ({ applied: false }),
      deleteKeychainValues: async () => ({ applied: false }),
    },
    ["a"],
  );
  const s = await setup(client);
  await s.type("Keychain key", "a");
  await s.click("Set");
  expect(s.text()).toContain(
    "com.example.app did not answer. It applies the change if it starts within the next hour. If it is open, use Set and relaunch.",
  );
  await s.click("Delete");
  expect(s.text()).toContain("It applies the change if it starts within the next hour.");
  expect(s.text()).not.toContain("Set and relaunch.");
});

test("keeps the form and shows a key that failed", async () => {
  const { client } = keychainClient({
    setKeychainValues: async () => ({
      applied: true,
      keys: [{ key: "a", status: -34018, ok: false, message: "no keychain entitlement" }],
    }),
  });
  const s = await setup(client);
  await s.type("Keychain key", "a");
  await s.type("Keychain value", "keep-me");
  await s.click("Set");
  expect(s.text()).toContain("a: no keychain entitlement");
  expect(s.text()).toContain("keep-me");
});

test("ignores the keys of a list that the app or the query replaced", async () => {
  let finishFirst: (keys: string[]) => void = () => {};
  let first = true;
  const { client } = keychainClient({
    listKeychainKeys: (_appId, options) =>
      first
        ? ((first = false), new Promise((resolve) => (finishFirst = resolve)))
        : Promise.resolve([`new-${(options as { service?: string }).service}`]),
  });
  const s = await setup(client);
  await s.type("Keychain service", "auth");
  await act(async () => s.field("Keychain service").props.onKeyDown({ key: "Enter" }));
  await act(async () => finishFirst(["stale"]));
  expect(s.text()).toContain("new-auth");
  expect(s.text()).not.toContain("stale");
});

test("shows a list failure with Retry", async () => {
  let fail = true;
  const { client } = keychainClient({
    listKeychainKeys: async () => {
      if (fail) throw new Error("com.example.app did not answer.");
      return ["a"];
    },
  });
  const s = await setup(client);
  expect(s.text()).toContain("did not answer");
  fail = false;
  await s.click("Retry");
  expect(s.text()).toContain('"a"');
});

describe("parseKeychainDraft", () => {
  test("takes a key and its value, or a JSON object of strings", () => {
    expect(parseKeychainDraft(" token ", "")).toEqual({ ok: true, values: { token: "" } });
    expect(parseKeychainDraft("", '{"a":"1"}')).toEqual({ ok: true, values: { a: "1" } });
  });

  test("refuses anything else without a key", () => {
    for (const value of ["", "tok", "[]", "{}", '{"a":1}']) {
      expect(parseKeychainDraft("", value).ok).toBe(false);
    }
  });
});

test("describeKeychainWrite reports the keys serve-sim marked ok", () => {
  const notFound = { key: "a", status: -25300, message: "not found" };
  expect(
    describeKeychainWrite(
      "delete",
      { applied: true, keys: [{ ...notFound, ok: true }] },
      false,
      "x",
    ),
  ).toEqual({ note: "Deleted a in x.", error: null });
  expect(
    describeKeychainWrite("set", { applied: true, keys: [{ ...notFound, ok: false }] }, false, "x"),
  ).toEqual({ note: null, error: "a: not found" });
});
