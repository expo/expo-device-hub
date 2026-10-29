import { expect, test } from "bun:test";

import { createLatestWriter, type LatestWriteOutcome } from "../latest-writer";

function deferred() {
  let resolve!: () => void;
  let reject!: (error: Error) => void;
  const promise = new Promise<void>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, resolve, reject };
}

const flush = () => new Promise((resolve) => setTimeout(resolve, 0));

test("a failed write does not block a later one, and each newest outcome is reported", async () => {
  const writes: string[] = [];
  const gates = [deferred(), deferred()];
  const outcomes: Array<LatestWriteOutcome<string, string>> = [];
  const write = createLatestWriter(
    async (value: string) => {
      writes.push(value);
      await gates[writes.length - 1]!.promise;
      return `${value} done`;
    },
    (outcome) => outcomes.push(outcome),
  );

  write("first");
  gates[0]!.reject(new Error("refused"));
  await flush();
  expect(outcomes).toEqual([{ value: "first", ok: false, error: new Error("refused") }]);

  write("second");
  gates[1]!.resolve();
  await flush();
  expect(writes).toEqual(["first", "second"]);
  expect(outcomes.at(-1)).toEqual({ value: "second", ok: true, result: "second done" });
});

test("only the newest write runs after the one in flight, and only its outcome is reported", async () => {
  const writes: string[] = [];
  const gate = deferred();
  const outcomes: string[] = [];
  const write = createLatestWriter(
    async (value: string) => {
      writes.push(value);
      if (value === "a") await gate.promise;
      return value;
    },
    (outcome) => outcomes.push(outcome.value),
  );

  write("a");
  write("b");
  write("c");
  expect(writes).toEqual(["a"]);
  gate.resolve();
  await flush();
  expect(writes).toEqual(["a", "c"]);
  // `a` was answered after `c` was chosen, so its answer is not shown.
  expect(outcomes).toEqual(["c"]);
});
