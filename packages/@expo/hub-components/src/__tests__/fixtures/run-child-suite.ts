import { join } from "node:path";

/**
 * Run one test fixture in its own Bun process, as serve-sim does. A fixture
 * that replaces a module such as `three` cannot share a process with the rest
 * of the suite. The child is killed on a deadline, so an orphan cannot keep a
 * CI job alive.
 */
export async function runChildSuite(
  fixture: string,
  { timeoutMs = 60_000 }: { timeoutMs?: number } = {},
): Promise<{ exitCode: number | null; output: string }> {
  const child = Bun.spawn([process.execPath, "test", `./src/__tests__/fixtures/${fixture}`], {
    cwd: join(import.meta.dir, "..", "..", ".."),
    stdout: "pipe",
    stderr: "pipe",
  });
  let timedOut = false;
  const killer = setTimeout(() => {
    timedOut = true;
    child.kill("SIGKILL");
  }, timeoutMs);
  try {
    const [exitCode, stderr, stdout] = await Promise.all([
      child.exited,
      new Response(child.stderr).text(),
      new Response(child.stdout).text(),
    ]);
    return {
      exitCode: timedOut ? null : exitCode,
      output: timedOut
        ? `${stderr}${stdout}\n(child killed after ${timeoutMs}ms)`
        : `${stderr}${stdout}`,
    };
  } finally {
    clearTimeout(killer);
    child.kill("SIGKILL");
  }
}
