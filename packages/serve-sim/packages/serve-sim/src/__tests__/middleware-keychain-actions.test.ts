import { expect, mock, spyOn, test } from "bun:test";
import * as capabilitySessions from "../capability-session";
import * as keychain from "../keychain";
import * as launchManager from "../launch-manager";
import { simMiddleware } from "../middleware";
import * as simKeychain from "../sim-keychain";
import type { UpgradeHandlerWebSocket } from "../socket/types";
import { UDID, useTempStateDir } from "./helpers";

const OPTIONS = {
  basePath: "/",
  execToken: "test-token",
  requirePreviewToken: true,
  loopbackOnly: true,
  clipboard: "unmanaged" as const,
};

function connection(middleware: ReturnType<typeof simMiddleware>) {
  let receive!: (data: string) => void;
  const waiting = new Map<number, (reply: { exitCode: number; stderr: string }) => void>();
  const socket: UpgradeHandlerWebSocket = {
    OPEN: 1,
    readyState: 1,
    send(data) {
      const reply = JSON.parse(String(data));
      waiting.get(reply.id)?.(reply);
    },
    on(event, handler) {
      if (event === "message") receive = handler as typeof receive;
    },
    close() {},
  };
  middleware.handleWebSocket?.(
    new Request("http://127.0.0.1:3200/exec-ws", {
      headers: { "Sec-WebSocket-Protocol": "serve-sim.token.test-token" },
    }),
    socket,
  );
  let id = 0;
  return (action: string, params: Record<string, unknown> = {}) => {
    const requestId = ++id;
    return new Promise<{ exitCode: number; stderr: string }>((resolve) => {
      waiting.set(requestId, resolve);
      receive(
        JSON.stringify({
          id: requestId,
          action,
          params: { udid: UDID.toLowerCase(), bundleId: "dev.test.app", ...params },
        }),
      );
    });
  };
}

for (const [action, params] of [
  ["keychain.set", { values: { token: "test-value" } }],
  ["keychain.delete", { keys: ["token"] }],
  ["keychain.list", {}],
] as const) {
  test(`middleware refuses ${action} when keychain is disabled on this server`, async () => {
    const state = useTempStateDir();
    const enabled = spyOn(launchManager, "isCapabilityEnabled").mockReturnValue(true);
    const set = spyOn(keychain, "setKeychainValues").mockResolvedValue({ applied: true, keys: [] });
    const remove = spyOn(keychain, "deleteKeychainValues").mockResolvedValue({
      applied: true,
      keys: [],
    });
    const list = spyOn(keychain, "listKeychainKeys").mockResolvedValue(["token"]);
    const middleware = simMiddleware({ ...OPTIONS, keychain: false });
    try {
      const result = await connection(middleware)(action, params);
      expect(result.exitCode).toBe(1);
      expect(result.stderr).toContain("off");
      expect(set).not.toHaveBeenCalled();
      expect(remove).not.toHaveBeenCalled();
      expect(list).not.toHaveBeenCalled();
    } finally {
      await middleware.dispose();
      enabled.mockRestore();
      set.mockRestore();
      remove.mockRestore();
      list.mockRestore();
      state.restore();
    }
  });
}

test.each([
  { name: "the first keychain action waits for middleware setup", failSetup: false },
  { name: "failed middleware setup refuses the keychain action", failSetup: true },
])("$name", async ({ failSetup }) => {
  const state = useTempStateDir();
  let ready!: () => void;
  const setup = new Promise<void>((resolve) => {
    ready = resolve;
  });
  const initialized = mock(async () => {
    await setup;
    if (failSetup) throw new Error("keychain setup failed");
  });
  const originalCreate = capabilitySessions.createCapabilitySession;
  const create = spyOn(capabilitySessions, "createCapabilitySession").mockImplementation(
    (definition, enabled) => ({
      ...originalCreate(definition, enabled),
      initialize: initialized,
    }),
  );
  const dylib = spyOn(simKeychain, "locateKeychainDylib").mockReturnValue("/test/keychain.dylib");
  const set = spyOn(keychain, "setKeychainValues").mockResolvedValue({ applied: true, keys: [] });
  const middleware = simMiddleware(OPTIONS);
  const pending = connection(middleware)("keychain.set", { values: { token: "test-value" } });
  try {
    await Bun.sleep(0);
    expect(initialized).toHaveBeenCalledWith(UDID);
    expect(set).not.toHaveBeenCalled();
    ready();
    const result = await pending;
    expect(result.exitCode).toBe(failSetup ? 1 : 0);
    if (failSetup) {
      expect(result.stderr).toContain("keychain setup failed");
      expect(set).not.toHaveBeenCalled();
    } else {
      expect(set).toHaveBeenCalledTimes(1);
    }
  } finally {
    ready();
    await pending;
    await middleware.dispose();
    create.mockRestore();
    dylib.mockRestore();
    set.mockRestore();
    state.restore();
  }
});

test("unmanaged keychain actions leave setup to the owning process", async () => {
  const state = useTempStateDir();
  const create = spyOn(capabilitySessions, "createCapabilitySession");
  const set = spyOn(keychain, "setKeychainValues").mockResolvedValue({ applied: true, keys: [] });
  const middleware = simMiddleware({ ...OPTIONS, keychain: "unmanaged" });
  try {
    const result = await connection(middleware)("keychain.set", {
      values: { token: "test-value" },
    });
    expect(result.exitCode).toBe(0);
    expect(create).not.toHaveBeenCalled();
    expect(set).toHaveBeenCalledTimes(1);
  } finally {
    await middleware.dispose();
    create.mockRestore();
    set.mockRestore();
    state.restore();
  }
});
