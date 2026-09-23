import { spawn } from "bun";
import { describe, expect, test } from "bun:test";
import { mkdtempSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { logTail, shellEscape } from "../guest";

async function echoedByBash(values: string[]): Promise<string[]> {
  const args = values.map(shellEscape).join(" ");
  const proc = spawn(["bash", "-s"], {
    stdin: Buffer.from(`printf '%s\\0' ${args}\n`),
    stdout: "pipe",
    stderr: "ignore",
  });
  const out = await new Response(proc.stdout).text();
  return out.split("\0").slice(0, -1);
}

describe("shellEscape", () => {
  test("survives expansion and substitution", async () => {
    const values = [
      "src/$HOME.test.ts",
      "src/`id -un`.test.ts",
      "src/$(id -un).test.ts",
      "src/my file.test.ts",
      "/Volumes/My Shared Files/serve-sim/packages/serve-sim",
    ];
    expect(await echoedByBash(values)).toEqual(values);
  });

  test("survives quotes, backslashes and newlines", async () => {
    const values = ["src/it's.test.ts", "'", "a'b'c", 'say "hi"', "back\\slash", "two\nlines"];
    expect(await echoedByBash(values)).toEqual(values);
  });
});

describe("logTail", () => {
  const dir = mkdtempSync(join(tmpdir(), "tart-log-"));

  test("points at the file when there is nothing to show", () => {
    const missing = join(dir, "missing.log");
    expect(logTail(missing)).toBe(`See ${missing}.`);
    const empty = join(dir, "empty.log");
    writeFileSync(empty, "");
    expect(logTail(empty)).toBe(`See ${empty}.`);
  });

  test("keeps the last ten lines", () => {
    const path = join(dir, "long.log");
    writeFileSync(path, Array.from({ length: 20 }, (_, i) => `line ${i + 1}`).join("\n"));
    const tail = logTail(path);
    expect(tail).toContain("line 11");
    expect(tail).not.toContain("line 10");
    expect(tail.split("\n")).toHaveLength(11);
  });
});
