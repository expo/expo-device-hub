import { join } from "path";

/**
 * Run one test fixture in its own bun process.
 *
 * Some fixtures replace a global or a module binding that survives `mock.restore`, so they cannot
 * share a process with the rest of the suite. The child is killed on a deadline: an orphan that
 * outlives its test keeps the CI job alive long after `bun test` itself has finished.
 */
export async function runChildSuite(
  fixture: string,
  { timeoutMs = 60_000 }: { timeoutMs?: number } = {},
): Promise<{ exitCode: number | null; output: string }> {
  const child = Bun.spawn(["bun", "test", `./src/__tests__/fixtures/${fixture}`], {
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
      output: timedOut ? `${stderr}${stdout}\n(child killed after ${timeoutMs}ms)` : `${stderr}${stdout}`,
    };
  } finally {
    clearTimeout(killer);
    child.kill("SIGKILL");
  }
}
