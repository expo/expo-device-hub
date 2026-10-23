import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { simMiddleware } from "../middleware";
import { useTempStateDir } from "./helpers";

async function request(path: string): Promise<Response> {
  const middleware = simMiddleware({ basePath: "/", proxyHelpers: true });
  const response = await middleware(new Request(`http://127.0.0.1:3200${path}`));
  if (!response) throw new Error(`Unhandled request: ${path}`);
  return response;
}

describe("readiness endpoints", () => {
  let tempState: ReturnType<typeof useTempStateDir>;
  beforeAll(() => {
    tempState = useTempStateDir();
  });
  afterAll(() => tempState.restore());

  test("reports process health without a simulator session", async () => {
    const response = await request("/healthz");
    expect(response.status).toBe(200);
    expect(response.headers.get("cache-control")).toBe("no-store");
    expect(await response.json()).toEqual({ status: "ok" });
  });

  test("does not report ready before a simulator session exists", async () => {
    const response = await request("/readyz");
    expect(response.status).toBe(503);
    expect(response.headers.get("cache-control")).toBe("no-store");
    expect(await response.json()).toEqual({ status: "starting" });
  });

  test("logs readiness failure and recovery without repeating polling diagnostics", async () => {
    const child = Bun.spawn(
      [process.execPath, "test", `${import.meta.dir}/fixtures/readiness-logging.child.ts`],
      {
        env: process.env,
        stdout: "pipe",
        stderr: "pipe",
      },
    );
    const [stdout, stderr, code] = await Promise.all([
      new Response(child.stdout).text(),
      new Response(child.stderr).text(),
      child.exited,
    ]);
    expect(code, stdout + stderr).toBe(0);
    const entries = stderr
      .split("\n")
      .filter((line) => line.startsWith("[readyz] "))
      .map((line) => JSON.parse(line.slice("[readyz] ".length)));
    expect(entries).toEqual([
      { status: "unavailable", reason: "session-unavailable", device: expect.any(String) },
      {
        status: "unavailable",
        reason: "capture-start-failed",
        device: expect.any(String),
        error: "capture initialization failed",
      },
      { status: "ready", device: expect.any(String) },
      { status: "unavailable", reason: "session-unavailable" },
      { status: "ready", device: expect.any(String) },
      { status: "unavailable", reason: "session-unavailable" },
    ]);
  });
});
