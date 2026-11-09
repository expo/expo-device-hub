import { expect, test } from "bun:test";
import sharp from "sharp";
import { screenshotResponse } from "../src/screenshot-response.ts";

test("benchmark validates image receipt and reports reuse without leaking credentials", async () => {
  const png = await sharp({ create: { width: 120, height: 260, channels: 4, background: "black" } })
    .png()
    .toBuffer();
  let requests = 0;
  const server = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    fetch(request) {
      expect(request.headers.get("authorization")).toBe("Bearer benchmark-test-only");
      requests++;
      return screenshotResponse(async () => png, new URL(request.url));
    },
  });
  try {
    const child = Bun.spawn(
      [
        Bun.which("node")!,
        new URL("../scripts/benchmark-screenshots.mjs", import.meta.url).pathname,
        server.url.href,
      ],
      {
        env: {
          ...process.env,
          SERVE_EMU_TOKEN: "benchmark-test-only",
          EXPO_DEVICE_HUB_SCREENSHOT_DIRECTORY: "",
        },
        stdout: "pipe",
        stderr: "pipe",
      },
    );
    const [stdout, stderr, code] = await Promise.all([
      new Response(child.stdout).text(),
      new Response(child.stderr).text(),
      child.exited,
    ]);
    expect(code, stderr).toBe(0);
    expect(stdout).not.toContain("benchmark-test-only");
    expect(stdout).not.toContain(server.url.href);
    const report = JSON.parse(stdout);
    expect(requests).toBe(24);
    expect(report.groups).toHaveLength(3);
    for (const group of report.groups) {
      expect(group.n).toBe(7);
      expect(group.reusedSockets).toBe(7);
      expect(group.bytes).toBeGreaterThan(0);
    }
    expect(
      report.samples.every(
        (s: { stages: Record<string, number> }) => s.stages.capture >= 0 && s.stages.encode >= 0,
      ),
    ).toBe(true);
  } finally {
    server.stop(true);
  }
});
