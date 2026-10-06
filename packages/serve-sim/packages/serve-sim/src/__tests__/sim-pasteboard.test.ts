import { describe, expect, spyOn, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { buildSimpbArtifact, writeSimPasteboard } from "../sim-pasteboard";
import { pasteTextIntoSim } from "../sim-pasteboard-paste";
import { installShims, withShimsAsync } from "./helpers";

describe("buildSimpbArtifact", () => {
  test("shares one build between concurrent callers and keeps the event loop running", async () => {
    // Other scripts that run in the meantime, such as an xcrun shim, still need the real bash.
    const shims = installShims({
      bash: [
        "#!/bin/sh",
        'case "$1" in */SimPasteboard/build.sh) ;; *) exec /bin/bash "$@" ;; esac',
        'echo build >> "$SERVE_SIM_SIMPB_DIR/builds"',
        "sleep 0.2",
        'touch "$SERVE_SIM_SIMPB_DIR/serve-sim-pasteboard"',
        "",
      ].join("\n"),
    });
    const oldToolDir = process.env.SERVE_SIM_SIMPB_DIR;
    process.env.SERVE_SIM_SIMPB_DIR = shims.dir;
    const log = spyOn(console, "error").mockImplementation(() => {});
    let ticks = 0;
    const timer = setInterval(() => { ticks++; }, 10);
    try {
      const built = await Promise.all([
        buildSimpbArtifact("SimPasteboard", "serve-sim-pasteboard"),
        buildSimpbArtifact("SimPasteboard", "serve-sim-pasteboard"),
      ]);
      expect(built).toEqual([join(shims.dir, "serve-sim-pasteboard"), join(shims.dir, "serve-sim-pasteboard")]);
      expect(readFileSync(join(shims.dir, "builds"), "utf8")).toBe("build\n");
      expect(ticks).toBeGreaterThan(0);
    } finally {
      clearInterval(timer);
      log.mockRestore();
      if (oldToolDir === undefined) delete process.env.SERVE_SIM_SIMPB_DIR;
      else process.env.SERVE_SIM_SIMPB_DIR = oldToolDir;
      shims.restore();
    }
  });
});

describe("writeSimPasteboard", () => {
  test("holds the device lock through the paste shortcut", async () => {
    const dir = mkdtempSync(join(tmpdir(), "serve-sim-paste-lock-test-"));
    const log = join(dir, "writes");
    const quotedLog = "'" + log.replaceAll("'", "'\\''") + "'";
    let release!: () => void;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    let shortcutStarted!: () => void;
    const shortcut = new Promise<void>((resolve) => { shortcutStarted = resolve; });
    try {
      await withShimsAsync({ xcrun: `#!/bin/sh\ncat >> ${quotedLog}\nprintf '\n' >> ${quotedLog}\n` }, async () => {
        const udid = `PASTE-LOCK-TEST-${process.pid}`;
        const first = pasteTextIntoSim(udid, "alpha", async () => {
          shortcutStarted();
          await gate;
        });
        await shortcut;
        const second = writeSimPasteboard(udid, "beta");
        try {
          await Bun.sleep(100);
          expect(readFileSync(log, "utf8")).toBe("alpha\n");
        } finally {
          release();
        }
        await Promise.all([first, second]);
        expect(readFileSync(log, "utf8")).toBe("alpha\nbeta\n");
      });
    } finally {
      release();
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("reports simctl's reason when it exits without reading the text", async () => {
    const shims = installShims({
      // Close stdin and stay alive, so the write fails with EPIPE before xcrun exits.
      xcrun: ["#!/bin/sh", "exec 0<&-", 'echo "Invalid device: $3" >&2', "sleep 1", "exit 148", ""].join("\n"),
      "serve-sim-pasteboard": "",
    });
    const oldToolDir = process.env.SERVE_SIM_SIMPB_DIR;
    process.env.SERVE_SIM_SIMPB_DIR = shims.dir;
    try {
      // Larger than a pipe buffer, so the write cannot finish before stdin closes.
      const text = "x".repeat(1024 * 1024);
      await expect(writeSimPasteboard("00000000-0000-0000-0000-000000000000", text))
        .rejects.toThrow("Invalid device: 00000000-0000-0000-0000-000000000000");
    } finally {
      if (oldToolDir === undefined) delete process.env.SERVE_SIM_SIMPB_DIR;
      else process.env.SERVE_SIM_SIMPB_DIR = oldToolDir;
      shims.restore();
    }
  });
});
