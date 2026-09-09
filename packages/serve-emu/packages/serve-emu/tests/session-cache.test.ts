import { expect, test } from "bun:test";
import { SessionScopedCache } from "../src/server/session-cache.ts";

type Deferred<T> = {
  promise: Promise<T>;
  resolve(value: T): void;
};

function deferred<T>(): Deferred<T> {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

test("old device loads cannot populate or clear the new generation cache", async () => {
  let generation = 1;
  let now = 100;
  const oldLoad = deferred<string>();
  const newLoad = deferred<string>();
  const loads = [oldLoad, newLoad];
  let loadIndex = 0;
  const cache = new SessionScopedCache(
    () => generation,
    () => now,
    () => loads[loadIndex++].promise,
  );

  const oldRequest = cache.get(1_000);
  generation++;
  cache.reset();
  const newRequest = cache.get(1_000);

  oldLoad.resolve("old-device-nodes");
  expect(await oldRequest).toBe("old-device-nodes");
  expect(cache.get(1_000)).toBe(newRequest);

  newLoad.resolve("new-device-nodes");
  expect(await newRequest).toBe("new-device-nodes");
  now += 500;
  expect(await cache.get(1_000)).toBe("new-device-nodes");
  expect(loadIndex).toBe(2);
});
