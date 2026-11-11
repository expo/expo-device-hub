import { expect, test } from "bun:test";
import type { CapabilityDefinition } from "../capability";
import { createCapabilitySession, type CapabilitySessionBackend } from "../session";

test("a supplied definition shares foreign setup and releases only setup acquired here", async () => {
  const definition: CapabilityDefinition = {
    name: "test-reader",
    defaultEnabled: true,
    scope: "userApps",
    setEnabled: async () => null,
  };
  const states = new Map<string, { capabilities: Record<string, { ownerPid: number | null }> }>([
    ["foreign", { capabilities: { "test-reader": { ownerPid: 456 } } }],
  ]);
  const acquired: string[] = [];
  const released: string[] = [];
  const configured: Array<{ udid: string; definition: CapabilityDefinition; enabled: boolean }> =
    [];
  const backend: CapabilitySessionBackend = {
    ownerPid: 123,
    isEnabled: (udid, name) => !!states.get(udid)?.capabilities[name],
    isArmed: async (udid, name) => !!states.get(udid)?.capabilities[name],
    readState: (udid) => states.get(udid) ?? null,
    async configure(udid, supplied, enabled) {
      configured.push({ udid, definition: supplied, enabled });
      const state = states.get(udid) ?? { capabilities: {} };
      if (enabled) state.capabilities[supplied.name] = { ownerPid: 123 };
      else delete state.capabilities[supplied.name];
      states.set(udid, state);
    },
    rearm: async () => {},
    async release(udid) {
      released.push(udid);
      states.delete(udid);
    },
    acquired: (udid) => acquired.push(udid),
  };
  const session = createCapabilitySession(definition, true, backend);
  await Promise.all([
    session.initialize("local"),
    session.initialize("local"),
    session.initialize("foreign"),
  ]);
  expect(configured).toEqual([{ udid: "local", definition, enabled: true }]);
  expect(acquired).toEqual(["local"]);
  await session.dispose();
  expect(configured).toEqual([
    { udid: "local", definition, enabled: true },
    { udid: "local", definition, enabled: false },
  ]);
  expect(released).toEqual(["local"]);
  expect(states.get("foreign")?.capabilities[definition.name]?.ownerPid).toBe(456);
});
