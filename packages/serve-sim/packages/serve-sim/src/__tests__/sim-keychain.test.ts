import { describe, expect, test } from "bun:test";
import { mkdtempSync, promises as fs, readdirSync, statSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import {
  MAX_KEYCHAIN_REQUEST_BYTES,
  QUEUED_REQUEST_TTL_MS,
  requestKeychain,
  runKeychainOperations,
  type KeychainOperation,
} from "../sim-keychain";

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

  test("refuses a request over the size the app reads", async () => {
    const root = container();
    const huge = { ...SET, data: "A".repeat(MAX_KEYCHAIN_REQUEST_BYTES) };
    await expect(requestKeychain(root, [huge])).rejects.toThrow("Send fewer or smaller items");
  });

  test("refuses a container that is not an absolute path", async () => {
    await expect(requestKeychain("(null)", [SET])).rejects.toThrow("Not an app data container");
  });
});

test("refuses a system app, which the capability loader never reaches", async () => {
  await expect(runKeychainOperations("UDID", "com.apple.Preferences", [SET])).rejects.toThrow(
    "com.apple.Preferences is a system app",
  );
});
