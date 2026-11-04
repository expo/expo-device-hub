import { afterEach, beforeEach, describe, expect, spyOn, test } from "bun:test";
import { createCapabilityController, createCapabilitySession } from "../capability-session";
import { runHostActionAsync } from "../host-actions";
import * as keychain from "../keychain";
import * as launchManager from "../launch-manager";
import { keychainCapability } from "../sim-keychain";
import { UDID, useTempStateDir } from "./helpers";

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
});
