import { describe, expect, spyOn, test } from "bun:test";
import { existsSync, mkdtempSync, promises as fs, readdirSync, statSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { execFile, execFileSync } from "child_process";
import { promisify } from "util";
import * as launchManager from "../launch-manager";
import { deleteKeychainValues } from "../keychain";
import { writeLaunchState } from "../launch-state";
import * as simctlModule from "../simctl";
import {
  MAX_KEYCHAIN_REQUEST_BYTES,
  QUEUED_REQUEST_TTL_MS,
  requestKeychain,
  runKeychainOperations,
  type KeychainOperation,
} from "../sim-keychain";
import { useTempStateDir } from "./helpers";

function container(): string {
  return mkdtempSync(join(tmpdir(), "serve-sim-keychain-"));
}

function mailbox(root: string) {
  const dir = join(root, "tmp", "serve-sim-keychain");
  return { requests: join(dir, "requests"), responses: join(dir, "responses") };
}

const SET: KeychainOperation = {
  op: "set",
  service: "app:no-auth",
  account: Buffer.from("accessToken").toString("base64"),
  data: Buffer.from("secret").toString("base64"),
};

async function waitForRequests(root: string, count = 1): Promise<string[]> {
  for (let attempt = 0; attempt < 400; attempt++) {
    const names = await fs.readdir(mailbox(root).requests).catch(() => [] as string[]);
    const ready = names.filter((name) => name.endsWith(".json")).sort();
    if (ready.length >= count) return ready;
    await Bun.sleep(5);
  }
  throw new Error("no request arrived");
}

/** Plays the dylib: claims the oldest request and answers with `answer(request)`. */
async function answerOnce(
  root: string,
  answer: (request: { nonce: string; operations: unknown[] }) => unknown,
): Promise<{ nonce: string; operations: unknown[] }> {
  const [name] = await waitForRequests(root);
  const path = join(mailbox(root).requests, name!);
  const request = JSON.parse(await fs.readFile(path, "utf-8"));
  await fs.rm(path);
  const done = join(mailbox(root).responses, `${request.nonce}.json`);
  await fs.writeFile(`${done}.pending`, JSON.stringify(answer(request)));
  await fs.rename(`${done}.pending`, done);
  return request;
}

describe("requestKeychain", () => {
  test("sends the operations and returns the app's results", async () => {
    const root = container();
    const answered = answerOnce(root, ({ nonce }) => ({ nonce, results: [{ status: 0 }] }));
    expect(await requestKeychain(root, [SET], { timeoutMs: 3000 })).toEqual([{ status: 0 }]);
    expect((await answered).operations).toEqual([SET]);
    expect(readdirSync(mailbox(root).responses)).toEqual([]);
  });

  test("serializes across host state directories when the app clears temp", async () => {
    const root = container();
    const first = requestKeychain(root, [SET], { timeoutMs: 3000 });
    try {
      const [name] = await waitForRequests(root);
      const { nonce } = JSON.parse(await fs.readFile(join(mailbox(root).requests, name!), "utf8"));
      await fs.rm(join(root, "tmp"), { recursive: true });
      await fs.mkdir(mailbox(root).requests, { recursive: true });
      await fs.mkdir(mailbox(root).responses, { recursive: true });
      const child = join(import.meta.dir, "fixtures/keychain-queue.child.ts");
      const second = promisify(execFile)(
        process.execPath,
        [child, root, String(Date.now()), '["newer"]'],
        {
          env: { ...process.env, SERVE_SIM_STATE_DIR: join(root, "other-state") },
          timeout: 5000,
        },
      );
      const completedEarly = await Promise.race([
        second.then(() => true),
        Bun.sleep(200).then(() => false),
      ]);
      await fs.writeFile(
        join(mailbox(root).responses, `${nonce}.json`),
        JSON.stringify({ nonce, results: [{ status: 0 }] }),
      );
      expect(await first).toEqual([{ status: 0 }]);
      await second;
      expect(completedEarly).toBe(false);
      expect(await waitForRequests(root)).toHaveLength(1);
    } finally {
      await fs.rm(root, { recursive: true, force: true });
    }
  });

  test("gives the request an expiry an hour out", async () => {
    const root = container();
    const before = Date.now();
    const answered = answerOnce(root, ({ nonce }) => ({ nonce, results: [{ status: 0 }] }));
    await requestKeychain(root, [SET], { timeoutMs: 3000 });
    const { expiresAt } = (await answered) as unknown as { expiresAt: number };
    expect(expiresAt).toBeGreaterThanOrEqual(before + QUEUED_REQUEST_TTL_MS);
    expect(expiresAt).toBeLessThanOrEqual(Date.now() + QUEUED_REQUEST_TTL_MS);
  });

  test("writes the request privately", async () => {
    const root = container();
    const seen = (async () => {
      const [name] = await waitForRequests(root);
      return statSync(join(mailbox(root).requests, name!)).mode & 0o777;
    })();
    expect(await requestKeychain(root, [SET], { timeoutMs: 200, keepQueued: true })).toBeNull();
    expect(await seen).toBe(0o600);
    expect(statSync(mailbox(root).requests).mode & 0o777).toBe(0o700);
  });

  test("withdraws an unanswered request by default", async () => {
    const root = container();
    expect(await requestKeychain(root, [SET], { timeoutMs: 100 })).toBeNull();
    expect(readdirSync(mailbox(root).requests)).toEqual([]);
  });

  test("keeps an unanswered request queued in order when asked", async () => {
    const root = container();
    expect(await requestKeychain(root, [SET], { timeoutMs: 50, keepQueued: true })).toBeNull();
    const second = { ...SET, data: Buffer.from("newer").toString("base64") };
    expect(await requestKeychain(root, [second], { timeoutMs: 50, keepQueued: true })).toBeNull();
    const names = await waitForRequests(root, 2);
    const bodies = await Promise.all(
      names.map(async (name) =>
        JSON.parse(await fs.readFile(join(mailbox(root).requests, name), "utf-8")),
      ),
    );
    expect(bodies.map((body) => body.operations[0].data)).toEqual([SET.data, second.data]);
  });

  test("waits for the answer to a request the app claimed at the deadline", async () => {
    const root = container();
    void (async () => {
      const [name] = await waitForRequests(root);
      const path = join(mailbox(root).requests, name!);
      const { nonce } = JSON.parse(await fs.readFile(path, "utf-8"));
      // Claimed before the 100 ms deadline, answered after it.
      await fs.rename(path, `${path}.claimed`);
      await Bun.sleep(400);
      await fs.writeFile(
        join(mailbox(root).responses, `${nonce}.json`),
        JSON.stringify({ nonce, results: [{ status: 0 }] }),
      );
    })();
    expect(await requestKeychain(root, [SET], { timeoutMs: 100 })).toEqual([{ status: 0 }]);
  });

  test("keeps publication order across processes with the same clock", async () => {
    const root = container();
    const clock = Date.now();
    const child = join(import.meta.dir, "fixtures/keychain-queue.child.ts");
    for (const values of [["first", "second"], ["third"]]) {
      execFileSync(process.execPath, [child, root, String(clock), JSON.stringify(values)], {
        timeout: 10_000,
      });
    }
    const names = await waitForRequests(root, 3);
    const values = await Promise.all(
      names.map(async (name) => {
        const body = JSON.parse(await fs.readFile(join(mailbox(root).requests, name), "utf8"));
        return Buffer.from(body.operations[0].data, "base64").toString("utf8");
      }),
    );
    expect(values).toEqual(["first", "second", "third"]);
  });

  test("reports a claimed request that never gets an answer", async () => {
    const root = container();
    void (async () => {
      const [name] = await waitForRequests(root);
      const path = join(mailbox(root).requests, name!);
      await fs.rename(path, `${path}.claimed`);
    })();
    await expect(requestKeychain(root, [SET], { timeoutMs: 100 })).rejects.toThrow(
      "took the keychain request but did not answer",
    );
  }, 10_000);

  test("removes expired requests and answers nobody read after an hour", async () => {
    const root = container();
    await requestKeychain(root, [SET], { timeoutMs: 10 });
    const twoHoursAgo = new Date(Date.now() - 2 * 60 * 60 * 1000);
    for (const dir of [mailbox(root).requests, mailbox(root).responses]) {
      await fs.writeFile(join(dir, "old.json"), "{}");
      await fs.writeFile(join(dir, "recent.json"), "{}");
      await fs.utimes(join(dir, "old.json"), twoHoursAgo, twoHoursAgo);
    }
    await requestKeychain(root, [SET], { timeoutMs: 10 });
    expect(readdirSync(mailbox(root).requests)).toEqual(["recent.json"]);
    expect(readdirSync(mailbox(root).responses)).toEqual(["recent.json"]);
  });

  test("rejects an answer whose nonce does not match its file", async () => {
    const root = container();
    void answerOnce(root, () => ({ nonce: "someone-else", results: [] }));
    await expect(requestKeychain(root, [SET], { timeoutMs: 3000 })).rejects.toThrow(
      "unreadable keychain answer",
    );
  });

  test("rejects an unreadable answer", async () => {
    const root = container();
    void answerOnce(root, ({ nonce }) => ({ nonce, results: [{ status: "ok" }] }));
    await expect(requestKeychain(root, [SET], { timeoutMs: 3000 })).rejects.toThrow(
      "unreadable keychain answer",
    );
  });

  test("rejects an answer with no result per operation, as for a request the app could not read", async () => {
    const root = container();
    void answerOnce(root, ({ nonce }) => ({ nonce, results: [] }));
    await expect(requestKeychain(root, [SET], { timeoutMs: 3000 })).rejects.toThrow(
      "unreadable keychain answer",
    );
  });

  test("validates before stopping the app and withdraws the request if starting fails", async () => {
    const root = container();
    const state = useTempStateDir();
    const relaunch = { udid: "KEYCHAIN-RELAUNCH", bundleId: "dev.test.keychain" };
    const huge = { ...SET, data: "A".repeat(MAX_KEYCHAIN_REQUEST_BYTES) };
    const simctl = spyOn(simctlModule, "simctl").mockImplementation(async (args) => {
      if (args[0] === "launch") throw new Error("launch failed");
      return "";
    });
    try {
      await expect(requestKeychain(root, [huge], { relaunch })).rejects.toThrow(
        "Send fewer or smaller items",
      );
      expect(simctl).not.toHaveBeenCalled();
      await expect(requestKeychain(root, [SET], { relaunch })).rejects.toThrow("launch failed");
      expect(simctl.mock.calls.map(([args]) => args[0])).toEqual(["terminate", "launch"]);
      expect(readdirSync(mailbox(root).requests)).toEqual([]);
    } finally {
      simctl.mockRestore();
      state.restore();
      await fs.rm(root, { recursive: true, force: true });
    }
  });

  test("refuses a container that is not an absolute path", async () => {
    await expect(requestKeychain("(null)", [SET])).rejects.toThrow("Not an app data container");
  });
});

test("holds the device lock through publication and restart, then releases it before the answer", async () => {
  const root = await fs.realpath(container());
  const state = useTempStateDir();
  const udid = "KEYCHAIN-RELAUNCH";
  const bundleId = "dev.test.keychain";
  writeLaunchState(udid, { bundleId, launchArgs: ["--original"], capabilities: {} });
  const publishing = Promise.withResolvers<void>();
  const allowPublication = Promise.withResolvers<void>();
  const renameFile = fs.rename.bind(fs);
  const rename = spyOn(fs, "rename").mockImplementation(async (from, to) => {
    if (String(from).startsWith(`${mailbox(root).requests}/.`)) {
      publishing.resolve();
      await allowPublication.promise;
    }
    return renameFile(from, to);
  });
  const launches: string[][] = [];
  const enabled = spyOn(launchManager, "isCapabilityEnabled").mockReturnValue(true);
  const simctl = spyOn(simctlModule, "simctl").mockImplementation(async (args) => {
    if (args[0] === "get_app_container") return root;
    if (args[0] === "launch") {
      expect(readdirSync(mailbox(root).requests).some((name) => name.endsWith(".json"))).toBe(true);
      launches.push(args.slice(3));
    }
    return "";
  });
  const request = runKeychainOperations(udid, bundleId, [SET], {
    relaunch: true,
    timeoutMs: 3000,
  }).then(
    (value) => ({ value }),
    (error: unknown) => ({ error }),
  );
  try {
    await Promise.race([
      publishing.promise,
      request.then((outcome) => {
        throw new Error("The request ended before publishing", { cause: outcome });
      }),
    ]);
    const lockedAtPublication = existsSync(join(state.dir, `launch-${udid}.lock`));
    const competingLaunch = launchManager.launchApp(udid, { bundleId, launchArgs: ["--next"] });
    allowPublication.resolve();
    // The competing launch can finish even though the keychain request has no answer yet.
    await competingLaunch;
    await answerOnce(root, ({ nonce }) => ({ nonce, results: [{ status: 0 }] }));
    expect(await request).toEqual({ value: { applied: true, results: [{ status: 0 }] } });
    expect(lockedAtPublication).toBe(true);
    expect(launches).toEqual([["--original"], ["--next"]]);
  } finally {
    allowPublication.resolve();
    await request;
    rename.mockRestore();
    enabled.mockRestore();
    simctl.mockRestore();
    state.restore();
    await fs.rm(root, { recursive: true, force: true });
  }
});

test.each([
  { name: "restarts the app when request publication fails", restartFailure: undefined },
  {
    name: "reports publication and restart failures together",
    restartFailure: new Error("restart failed"),
  },
])("$name", async ({ restartFailure }) => {
  const root = container();
  const state = useTempStateDir();
  const enabled = spyOn(launchManager, "isCapabilityEnabled").mockReturnValue(true);
  const simctl = spyOn(simctlModule, "simctl").mockImplementation(async (args) => {
    if (args[0] === "get_app_container") return root;
    // Simulate the mailbox becoming unwritable only after the app has stopped.
    if (args[0] === "terminate") await fs.rm(mailbox(root).requests, { recursive: true });
    if (args[0] === "launch" && restartFailure) throw restartFailure;
    return "";
  });
  try {
    const error = await runKeychainOperations("UDID", "dev.test.keychain", [SET], {
      relaunch: true,
    }).catch((error: unknown) => error);
    expect(simctl.mock.calls.map(([args]) => args[0])).toEqual([
      "get_app_container",
      "terminate",
      "launch",
    ]);
    if (restartFailure) {
      expect(error).toBeInstanceOf(AggregateError);
      const errors = (error as AggregateError).errors;
      expect(errors[0]).toMatchObject({ code: "ENOENT" });
      expect(errors[1]).toBe(restartFailure);
    } else {
      expect(error).toMatchObject({ code: "ENOENT" });
    }
  } finally {
    enabled.mockRestore();
    simctl.mockRestore();
    state.restore();
    await fs.rm(root, { recursive: true, force: true });
  }
});

test("refuses a system app, which the capability loader never reaches", async () => {
  await expect(runKeychainOperations("UDID", "com.apple.Preferences", [SET])).rejects.toThrow(
    "com.apple.Preferences is a system app",
  );
});

test("withdraws an unacknowledged alias delete while a single-item delete can queue", async () => {
  const root = container();
  const enabled = spyOn(launchManager, "isCapabilityEnabled").mockReturnValue(true);
  const simctl = spyOn(simctlModule, "simctl").mockImplementation(async (args) =>
    args[0] === "get_app_container" ? root : "",
  );
  const target = { udid: "UDID", bundleId: "dev.test.keychain", options: { service: "auth" } };
  try {
    await expect(
      deleteKeychainValues({ ...target, format: "expo-secure-store" }, ["token"]),
    ).rejects.toThrow("Open the app in an up-to-date serve-sim session");
    expect(readdirSync(mailbox(root).requests)).toEqual([]);

    expect(
      await deleteKeychainValues({ ...target, format: "generic-password" }, ["token"]),
    ).toEqual({ applied: false });
    expect(readdirSync(mailbox(root).requests)).toHaveLength(1);
  } finally {
    simctl.mockRestore();
    enabled.mockRestore();
    await fs.rm(root, { recursive: true, force: true });
  }
});
