import { afterEach, beforeEach, describe, expect, spyOn, test } from "bun:test";
import { createCapabilityController, createCapabilitySession } from "../../capability-session";
import { runHostActionAsync } from "../../host-actions";
import * as keychain from "../../keychain";
import * as launchManager from "../../launch-manager";
import { keychainCapability } from "../../sim-keychain";
import { UDID, useTempStateDir } from "../helpers";

function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => {
    resolve = done;
  });
  return { promise, resolve: () => resolve() };
}

let state: ReturnType<typeof useTempStateDir>;
const restores: (() => void)[] = [];

beforeEach(() => {
  state = useTempStateDir();
});
afterEach(() => {
  for (const restore of restores.splice(0).reverse()) restore();
  state.restore();
});

async function managedSession(onChange?: () => void) {
  // Control the launch-manager boundary, not the session or host-action fence under test.
  const configure = spyOn(launchManager, "configureCapability").mockResolvedValue(undefined);
  const armed = spyOn(launchManager, "isCapabilityArmed").mockResolvedValue(false);
  const enabled = spyOn(launchManager, "isCapabilityEnabled").mockReturnValue(true);
  const release = spyOn(launchManager, "releaseSession").mockResolvedValue(undefined);
  restores.push(
    () => configure.mockRestore(),
    () => armed.mockRestore(),
    () => enabled.mockRestore(),
    () => release.mockRestore(),
  );
  const session = createCapabilitySession(keychainCapability);
  await session.initialize(UDID);
  const controller = createCapabilityController({ clipboard: null, keychain: session }, onChange);
  return { session, controller, configure, release };
}

describe("capability operation draining", () => {
  test("refuses startup-disabled, unopened, and unmanaged capability changes", async () => {
    const configure = spyOn(launchManager, "configureCapability").mockResolvedValue(undefined);
    restores.push(() => configure.mockRestore());
    const disabled = createCapabilitySession(keychainCapability, false);
    const unopened = createCapabilitySession(keychainCapability);
    const disabledController = createCapabilityController({ clipboard: null, keychain: disabled });
    const unopenedController = createCapabilityController({ clipboard: null, keychain: unopened });
    const unmanaged = createCapabilityController({ clipboard: null, keychain: null });
    try {
      await expect(disabledController.set(UDID, "keychain", true)).rejects.toThrow(
        "started with keychain disabled",
      );
      expect(disabled.allows(UDID)).toBe(false);
      for (const value of [false, true]) {
        await expect(unopenedController.set(UDID, "keychain", value)).rejects.toThrow(
          "has not opened",
        );
        await expect(unmanaged.set(UDID, "keychain", value)).rejects.toThrow(
          "does not manage keychain",
        );
      }
      expect(configure).not.toHaveBeenCalled();
    } finally {
      await Promise.all([disabled.dispose(), unopened.dispose()]);
    }
  });

  test.each([false, true])(
    "disable waits for an admitted keychain action (failure=%s)",
    async (fail) => {
      const events: string[] = [];
      const { session, controller, configure } = await managedSession(() => events.push("change"));
      const entered = deferred();
      const resume = deferred();
      const original = new Error("the admitted write failed");
      const set = spyOn(keychain, "setKeychainValues").mockImplementation(async () => {
        entered.resolve();
        await resume.promise;
        events.push("operation");
        if (fail) throw original;
        return { applied: false };
      });
      restores.push(() => set.mockRestore());
      const run = () =>
        runHostActionAsync(
          {
            action: "keychain.set",
            params: { udid: UDID, bundleId: "com.example.app", values: { token: "synthetic" } },
          },
          "false",
          undefined,
          undefined,
          (target) => session.prepare(target),
          controller,
        );
      let action: ReturnType<typeof run> | undefined;
      let disabling: Promise<void> | undefined;
      try {
        action = run();
        await entered.promise;
        let disabled = false;
        disabling = controller.set(UDID, "keychain", false).then(() => {
          disabled = true;
          events.push("disabled");
        });
        await Bun.sleep(0);
        // Preview polling must not remove setup while the admitted write is draining.
        await session.initialize(UDID);
        expect(disabled).toBe(false);
        expect(configure).toHaveBeenCalledTimes(1);
        // The visible choice closes admission immediately; it does not acknowledge drain completion.
        expect(controller.list(UDID)).toEqual([{ name: "keychain", enabled: false }]);
        expect(await run()).toMatchObject({
          exitCode: 1,
          stderr: expect.stringContaining("Keychain access is off"),
        });
        expect(set).toHaveBeenCalledTimes(1);
        expect(await controller.run(`${UDID}-other`, "keychain", async () => "independent")).toBe(
          "independent",
        );
        resume.resolve();
        expect(await action).toMatchObject(
          fail ? { exitCode: 1, stderr: original.message } : { exitCode: 0 },
        );
        await disabling;
        expect(events).toEqual(["operation", "change", "disabled"]);
        expect(configure).toHaveBeenLastCalledWith(UDID, keychainCapability, {
          enabled: false,
          relaunch: false,
        });
      } finally {
        resume.resolve();
        await Promise.allSettled([action, disabling]);
        await session.dispose();
      }
    },
  );

  test("disable drains action preparation before removing setup", async () => {
    const { session, controller, configure } = await managedSession();
    const entered = deferred();
    const resume = deferred();
    const set = spyOn(keychain, "setKeychainValues").mockResolvedValue({ applied: false });
    restores.push(() => set.mockRestore());
    const action = runHostActionAsync(
      {
        action: "keychain.set",
        params: { udid: UDID, bundleId: "com.example.app", values: { token: "synthetic" } },
      },
      "false",
      undefined,
      undefined,
      async (target) => {
        entered.resolve();
        await resume.promise;
        await session.prepare(target);
      },
      controller,
    );
    await entered.promise;
    let disabled = false;
    const disabling = controller.set(UDID, "keychain", false).then(() => {
      disabled = true;
    });
    try {
      await session.initialize(UDID);
      expect(disabled).toBe(false);
      expect(configure).toHaveBeenCalledTimes(1);
      expect(set).not.toHaveBeenCalled();
      resume.resolve();
      expect(await action).toMatchObject({ exitCode: 0 });
      await disabling;
      expect(set).toHaveBeenCalledTimes(1);
      expect(configure).toHaveBeenLastCalledWith(UDID, keychainCapability, {
        enabled: false,
        relaunch: false,
      });
    } finally {
      resume.resolve();
      await Promise.allSettled([action, disabling]);
      await session.dispose();
    }
  });

  test("disposal closes admission and drains operations before releasing the session", async () => {
    const { session, controller, release } = await managedSession();
    const entered = deferred();
    const resume = deferred();
    const operation = controller.run(UDID, "keychain", async () => {
      entered.resolve();
      await resume.promise;
      return "finished";
    });
    await entered.promise;
    let disposed = false;
    const disposal = session.dispose().then(() => {
      disposed = true;
    });
    try {
      await Bun.sleep(0);
      expect(disposed).toBe(false);
      expect(release).not.toHaveBeenCalled();
      await expect(controller.run(UDID, "keychain", async () => "late")).rejects.toThrow(
        "session has ended",
      );
      resume.resolve();
      expect(await operation).toBe("finished");
      await disposal;
      expect(release).toHaveBeenCalledWith(UDID, process.pid, expect.any(Function));
    } finally {
      resume.resolve();
      await Promise.allSettled([operation, disposal]);
    }
  });

  test("admitted preparation shares in-flight setup while disable drains", async () => {
    const { session, controller, configure } = await managedSession();
    const entered = deferred();
    const resume = deferred();
    configure.mockImplementationOnce(async () => {
      entered.resolve();
      await resume.promise;
    });
    const settingUp = session.initialize(UDID, true);
    await entered.promise;
    const set = spyOn(keychain, "setKeychainValues").mockResolvedValue({ applied: false });
    restores.push(() => set.mockRestore());
    const action = runHostActionAsync(
      {
        action: "keychain.set",
        params: { udid: UDID, bundleId: "com.example.app", values: { token: "synthetic" } },
      },
      "false",
      undefined,
      undefined,
      (target) => session.prepare(target),
      controller,
    );
    // Close admission before the admitted operation's preparation microtask starts.
    const disabling = controller.set(UDID, "keychain", false);
    let polled = false;
    const polling = session.initialize(UDID).then(() => {
      polled = true;
    });
    try {
      await Bun.sleep(0);
      expect(polled).toBe(false);
      expect(set).not.toHaveBeenCalled();
      expect(configure).toHaveBeenCalledTimes(2);
      resume.resolve();
      expect(await action).toMatchObject({ exitCode: 0 });
      await Promise.all([settingUp, polling, disabling]);
      expect(set).toHaveBeenCalledTimes(1);
      expect(configure).toHaveBeenLastCalledWith(UDID, keychainCapability, {
        enabled: false,
        relaunch: false,
      });
    } finally {
      resume.resolve();
      await Promise.allSettled([settingUp, action, polling, disabling]);
      await session.dispose();
    }
  });
});
