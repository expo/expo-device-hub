import { expect, test } from "bun:test";

// Keep module mocks and server environment out of other suites.
for (const scope of ["all", "ios", "android", "single"]) {
  test(`device inventory opt-in (${scope})`, async () => {
    const child = Bun.spawn([process.execPath, "test", "./fixtures/device-inventory.fixture.ts"], {
      cwd: import.meta.dir,
      env: { ...process.env, HUB_TEST_SCOPE: scope },
      stdout: "pipe",
      stderr: "pipe",
    });
    const [exitCode, stdout, stderr] = await Promise.all([
      child.exited,
      new Response(child.stdout).text(),
      new Response(child.stderr).text(),
    ]);
    expect(`${stdout}\n${stderr}`).toContain("0 fail");
    expect(exitCode).toBe(0);
  }, 15_000);
}
