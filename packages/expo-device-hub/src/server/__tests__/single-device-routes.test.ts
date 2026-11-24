import { expect, test } from "bun:test";

for (const platform of ["ios", "android"]) {
  test(`${platform} single-device policy is applied by the Hub routes`, async () => {
    const child = Bun.spawn(
      [process.execPath, "test", "./fixtures/single-device-routes.fixture.ts"],
      {
        cwd: import.meta.dir,
        env: { ...process.env, HUB_TEST_PLATFORM: platform },
        stdout: "pipe",
        stderr: "pipe",
      },
    );
    const [exitCode, stdout, stderr] = await Promise.all([
      child.exited,
      new Response(child.stdout).text(),
      new Response(child.stderr).text(),
    ]);
    expect(`${stdout}\n${stderr}`).toContain("0 fail");
    expect(exitCode).toBe(0);
  }, 15_000);
}
