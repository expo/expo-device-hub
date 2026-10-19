import { describe, it, expect } from "bun:test";
import { parseGuestProcesses } from "../guest-metrics";
import { mkdtemp, readFile, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { spawnSync } from "node:child_process";

describe(parseGuestProcesses, () => {
  it("parses cumulative CPU, parentage, start identity and paths containing spaces", () => {
    expect(
      parseGuestProcesses(
        " 12 1 Thu Oct  1 14:51:02 2026 2-03:04:05.50 200 /Applications/My App.app/App",
      )[0],
    ).toEqual({
      pid: 12,
      ppid: 1,
      started: "Thu Oct  1 14:51:02 2026",
      cpuSeconds: 183845.5,
      rssBytes: 204800,
      executable: "/Applications/My App.app/App",
    });
    expect(
      parseGuestProcesses("12 1 Thu Oct  1 14:51:02 2026 3:05.25 200 /bin/app")[0]!.cpuSeconds,
    ).toBe(185.25);
  });

  it("rejects an unrecognized row rather than silently undercounting", () => {
    expect(() => parseGuestProcesses("12 broken")).toThrow("Unrecognized ps row");
  });
});

it.skipIf(process.platform !== "darwin")(
  "profiles without selecting a device and protects an existing output",
  async () => {
    const directory = await mkdtemp(join(tmpdir(), "serve-sim-profile-test-"));
    const output = join(directory, "guest.ndjson");
    const cli = resolve(import.meta.dir, "../../dist/serve-sim.js");
    try {
      const first = spawnSync("node", [cli, "profile", output, "--duration", "1"], {
        encoding: "utf8",
        timeout: 15_000,
      });
      expect(first.status).toBe(0);
      const contents = await readFile(output, "utf8");
      const rows = contents
        .trim()
        .split("\n")
        .map((line) => JSON.parse(line));
      expect(rows[0].type).toBe("meta");
      expect(rows[0].cores).toBeGreaterThan(0);
      expect(rows.some((row) => row.type === "sample")).toBe(true);
      expect(rows.at(-1).reason).toBe("stopped");
      expect((await stat(output)).mode & 0o777).toBe(0o600);
      const second = spawnSync("node", [cli, "profile", output, "--duration", "1"], {
        encoding: "utf8",
        timeout: 15_000,
      });
      expect(second.status).not.toBe(0);
      expect(await readFile(output, "utf8")).toBe(contents);
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  },
);
