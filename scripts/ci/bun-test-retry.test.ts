import { afterEach, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { testWithRetry } from "./bun-test-retry";

let dir: string;
afterEach(() => rmSync(dir, { recursive: true, force: true }));

// Each fixture file appends its name to runs.log when it loads.
function fixture(files: Record<string, string>): string {
  dir = mkdtempSync(join(tmpdir(), "bun-test-retry-fixture-"));
  for (const [name, body] of Object.entries(files)) {
    writeFileSync(
      join(dir, name),
      `import { test, expect } from "bun:test";
import { appendFileSync, existsSync, writeFileSync } from "node:fs";
appendFileSync("runs.log", "${name}\\n");
${body}`,
    );
  }
  return dir;
}
const runs = () => readFileSync(join(dir, "runs.log"), "utf8").trim().split("\n").sort();

test("reruns only the failed file", async () => {
  const cwd = fixture({
    "flaky.test.ts": `test("flaky", () => { const first = !existsSync("seen"); writeFileSync("seen", ""); expect(first).toBe(false); });`,
    "ok.test.ts": `test("ok", () => {});`,
  });
  expect(await testWithRetry([], { cwd })).toBe(0);
  expect(runs()).toEqual(["flaky.test.ts", "flaky.test.ts", "ok.test.ts"]);
});

test("a persistent failure stays red", async () => {
  const cwd = fixture({ "hard.test.ts": `test("hard", () => expect(1).toBe(2));` });
  expect(await testWithRetry([], { cwd })).not.toBe(0);
  expect(runs()).toEqual(["hard.test.ts", "hard.test.ts"]);
});

test("a file that fails to load is not retried", async () => {
  const cwd = fixture({
    "flaky.test.ts": `test("flaky", () => { const first = !existsSync("seen"); writeFileSync("seen", ""); expect(first).toBe(false); });`,
    "broken.test.ts": `throw new Error("load");`,
  });
  expect(await testWithRetry([], { cwd })).not.toBe(0);
  expect(runs()).toEqual(["broken.test.ts", "flaky.test.ts"]);
});

test("test output that looks like Bun's error header does not block a retry", async () => {
  const cwd = fixture({
    "flaky.test.ts": `test("flaky", () => { const first = !existsSync("seen"); writeFileSync("seen", ""); expect(first).toBe(false); });`,
    "noisy.test.ts": `test("noisy", () => { console.error("# Unhandled error between tests"); console.error(" 1 error"); });`,
  });
  expect(await testWithRetry([], { cwd })).toBe(0);
  expect(runs()).toEqual(["flaky.test.ts", "flaky.test.ts", "noisy.test.ts"]);
});

test("a failed before-retry script stops the retry", async () => {
  const cwd = fixture({ "hard.test.ts": `test("hard", () => expect(1).toBe(2));` });
  writeFileSync(join(cwd, "before.sh"), "exit 3");
  expect(await testWithRetry([], { cwd, beforeRetry: "before.sh" })).not.toBe(0);
  expect(runs()).toEqual(["hard.test.ts"]);
});

test("a timed-out attempt is not retried", async () => {
  const cwd = fixture({
    "hang.test.ts": `test("hard", () => expect(1).toBe(2));
test("hang", () => new Promise(() => {}), 60_000);`,
  });
  expect(await testWithRetry([], { cwd, timeoutMs: 3_000 })).toBe(124);
  expect(runs()).toEqual(["hang.test.ts"]);
}, 10_000);
