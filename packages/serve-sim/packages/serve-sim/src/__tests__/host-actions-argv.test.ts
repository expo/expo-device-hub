import { afterAll, beforeAll, describe, expect, it } from "bun:test";

import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from "fs";
import { homedir, tmpdir } from "os";
import { dirname, join } from "path";

import { runHostActionAsync } from "../host-actions";
import { UDID, installShims, withActionTimeoutAsync, withShimsAsync } from "./helpers";

// Every CLI-backed action builds an argument vector by hand, and a wrong flag or a swapped
// positional would still exit 0 against a real tool. These shims report the argv they were handed,
// so the vector itself is asserted rather than the fact that something ran.
const SHIM = `#!/bin/sh
{
  printf '%s\\n' "$(basename "$0")"
  for a in "$@"; do printf '%s\\n' "$a"; done
} | tee -a "\${SERVE_SIM_ARGV_LOG:-/dev/null}"
`;

// The real sips writes its --out file, and the thumbnail test asserts that file is gone afterwards,
// so this shim has to leave one behind for that assertion to mean anything.
const SIPS_SHIM = `${SHIM}while [ "$#" -gt 1 ]; do
  [ "$1" = "--out" ] && : > "$2"
  shift
done
`;

/** Both the shims and the log parser read this, so adding a tool cannot desync the two. */
const SHIMMED = ["xcrun", "plutil", "open", "osascript", "sips", "base64", "cp", "serve-sim"];

function shimBody(name: string): string {
  return name === "sips" ? SIPS_SHIM : SHIM;
}

const BUNDLE = "com.example.app";
// Under an allowed root so ConfinedPath accepts it; never created, so nothing is written. The
// server canonicalizes the directory, so the expected argv uses the real path, not the lexical one.
const UPLOADS = join(tmpdir(), "serve-sim-uploads");
const CONFINED = join(realpathSync(tmpdir()), "serve-sim-uploads", "serve-sim-argv-fixture.png");
const SHOT = "serve-sim-screenshot-shot.png";
const STAGED = join(realpathSync(tmpdir()), "serve-sim-screenshots", SHOT);

let shims: ReturnType<typeof installShims>;
let serveSimBin: string;
let argvLog: string;

beforeAll(() => {
  shims = installShims(Object.fromEntries(SHIMMED.map((name) => [name, shimBody(name)])));
  serveSimBin = join(shims.dir, "serve-sim");
  argvLog = join(shims.dir, "argv.log");
  process.env.SERVE_SIM_ARGV_LOG = argvLog;
  mkdirSync(UPLOADS, { recursive: true });
});

afterAll(() => {
  delete process.env.SERVE_SIM_ARGV_LOG;
  shims.restore();
  // The xcrun shim never writes, so the reservation the capture staged is what is left behind.
  rmSync(STAGED, { force: true });
});

// Actions that replace stdout with their own result still leave their argv in the shim log.
function loggedArgv(): string[][] {
  const raw = existsSync(argvLog) ? readFileSync(argvLog, "utf8").trimEnd() : "";
  if (!raw) return [];
  const lines = raw.split("\n");
  const runs: string[][] = [];
  for (const line of lines) {
    if (SHIMMED.includes(line)) {
      runs.push([line]);
    } else {
      runs[runs.length - 1]?.push(line);
    }
  }
  return runs;
}

async function argv(action: string, params?: Record<string, unknown>): Promise<string[]> {
  const result = await runHostActionAsync(
    params === undefined ? { action } : { action, params },
    serveSimBin,
  );
  expect(result.exitCode).toBe(0);
  return result.stdout.trimEnd().split("\n");
}

describe("simctl-backed actions", () => {
  it("builds appearance get and set", async () => {
    expect(await argv("appearance.get", { udid: UDID })).toEqual([
      "xcrun", "simctl", "ui", UDID, "appearance",
    ]);
    expect(await argv("appearance.set", { udid: UDID, value: "dark" })).toEqual([
      "xcrun", "simctl", "ui", UDID, "appearance", "dark",
    ]);
  });

  it("builds location set and clear", async () => {
    expect(await argv("location.set", { udid: UDID, lat: 37.3349, lng: -122.009 })).toEqual([
      "xcrun", "simctl", "location", UDID, "set", "37.3349000,-122.0090000",
    ]);
    expect(await argv("location.clear", { udid: UDID })).toEqual([
      "xcrun", "simctl", "location", UDID, "clear",
    ]);
  });

  it("builds home springboard", async () => {
    expect(await argv("home.springboard", { udid: UDID })).toEqual([
      "xcrun", "simctl", "launch", UDID, "com.apple.springboard",
    ]);
  });

  // The trailing "app" selects the bundle container rather than the data container.
  it("builds app container", async () => {
    expect(await argv("app.container", { udid: UDID, bundleId: BUNDLE })).toEqual([
      "xcrun", "simctl", "get_app_container", UDID, BUNDLE, "app",
    ]);
  });

  it("builds app install and media add from a path", async () => {
    expect(await argv("app.install", { udid: UDID, path: CONFINED })).toEqual([
      "xcrun", "simctl", "install", UDID, CONFINED,
    ]);
    expect(await argv("media.add", { udid: UDID, path: CONFINED })).toEqual([
      "xcrun", "simctl", "addmedia", UDID, CONFINED,
    ]);
  });

  it("resolves a staged upload into the install path", async () => {
    const out = await argv("app.install", { udid: UDID, uploadId: "staged.ipa" });
    expect(out.slice(0, 4)).toEqual(["xcrun", "simctl", "install", UDID]);
    expect(out[4]).toMatch(/serve-sim-uploads\/staged\.ipa$/);
  });
});

describe("other host tools", () => {
  // -o - keeps plutil on stdout so it never rewrites the app's own Info.plist in place.
  it("builds the info plist read", async () => {
    expect(await argv("app.infoPlist", { path: CONFINED })).toEqual([
      "plutil", "-convert", "json", "-o", "-", CONFINED,
    ]);
  });

  it("builds reveal", async () => {
    expect(await argv("reveal", { path: CONFINED })).toEqual(["open", "-R", CONFINED]);
    expect(await argv("reveal", { screenshot: SHOT })).toEqual([
      "open", "-R", join(homedir(), "Desktop", SHOT),
    ]);
  });

  it("builds the watch home press as three -e scripts", async () => {
    const out = await argv("home.watch", { udid: UDID });
    expect(out[0]).toBe("osascript");
    expect(out.filter((a) => a === "-e")).toHaveLength(3);
    expect(out[out.length - 1]).toContain('click menu item "Home"');
  });
});

describe("procedures that shell out", () => {
  it("stages the capture and leaves the Desktop copy to a child", async () => {
    const result = await runHostActionAsync(
      { action: "screenshot.capture", params: { udid: UDID, fileName: SHOT } },
      serveSimBin,
    );
    expect(result.exitCode).toBe(0);
    // The page reads this back for the drag-and-drop URL, so it has to be the file simctl wrote.
    expect(result.stdout.trim()).toBe(STAGED);
    const runs = loggedArgv();
    expect(runs.filter((r) => r[0] === "xcrun").at(-1)).toEqual([
      "xcrun", "simctl", "io", UDID, "screenshot", STAGED,
    ]);
    expect(runs.filter((r) => r[0] === "cp").at(-1)).toEqual([
      "cp", STAGED, join(homedir(), "Desktop", SHOT),
    ]);
  });

  // A copy that never returns is what a consent prompt looks like from the child's side. The client
  // gives an action ten seconds, so the copy has to be reaped well inside that, and the capture is
  // still a success: the file simctl wrote is staged, and stderr says where.
  it("reaps a Desktop copy that hangs and still returns the staged path", async () => {
    const fileName = "serve-sim-screenshot-hung-copy.png";
    const staged = join(dirname(STAGED), fileName);
    try {
      // Tighter than the shipped two minutes, so a copy that fell back to the action deadline shows
      // up as a missed bound rather than a test that ran out of time.
      await withActionTimeoutAsync(9000, async () => {
        await withShimsAsync({ cp: "#!/bin/sh\nexec sleep 600\n" }, async () => {
          const started = Date.now();
          const result = await runHostActionAsync(
            { action: "screenshot.capture", params: { udid: UDID, fileName } },
            serveSimBin,
          );
          expect(Date.now() - started).toBeLessThan(8_000);
          expect(result.exitCode).toBe(0);
          expect(result.stdout.trim()).toBe(staged);
          expect(result.stderr).toContain(staged);
          expect(result.stderr).toContain("did not finish within 5s");
          expect(result.stderr).not.toContain("refused");
        });
      });
    } finally {
      rmSync(staged, { force: true });
    }
  }, 20_000);

  it("reports a refused Desktop copy without failing the capture", async () => {
    const fileName = "serve-sim-screenshot-refused-copy.png";
    const staged = join(dirname(STAGED), fileName);
    try {
      await withShimsAsync({ cp: "#!/bin/sh\necho 'cp: Operation not permitted' >&2\nexit 1\n" }, async () => {
        const result = await runHostActionAsync(
          { action: "screenshot.capture", params: { udid: UDID, fileName } },
          serveSimBin,
        );
        expect(result.exitCode).toBe(0);
        expect(result.stdout.trim()).toBe(staged);
        expect(result.stderr).toContain(staged);
        expect(result.stderr).toContain("refused the Desktop copy (cp: Operation not permitted)");
        expect(result.stderr).not.toContain("did not finish within");
      });
    } finally {
      rmSync(staged, { force: true });
    }
  });

  it("drops the reservation and skips the Desktop copy when simctl fails", async () => {
    const fileName = "serve-sim-screenshot-failed-capture.png";
    const staged = join(dirname(STAGED), fileName);
    const before = loggedArgv().length;
    try {
      await withShimsAsync({ xcrun: "#!/bin/sh\nexit 1\n" }, async () => {
        const result = await runHostActionAsync(
          { action: "screenshot.capture", params: { udid: UDID, fileName } },
          serveSimBin,
        );
        expect(result.exitCode).not.toBe(0);
      });
      expect(loggedArgv().slice(before).some((r) => r[0] === "cp")).toBe(false);
      expect(existsSync(staged)).toBe(false);
    } finally {
      rmSync(staged, { force: true });
    }
  });

  // The caller names the file, so two captures can name the same one. Only the reservation is
  // serialized; both simctl runs then race, and the loser's cleanup must not take the winner's
  // screenshot with it. The shim's mkdir is the tie-break: the first run writes and exits 0, the
  // second waits until that write has landed and exits 1. The opening sleep lets both reservations
  // land first, since the second one truncates the file.
  it("keeps a screenshot another capture of the same name wrote when this one fails", async () => {
    const fileName = "serve-sim-screenshot-shared-name.png";
    const staged = join(dirname(STAGED), fileName);
    const lock = `${staged}.lock`;
    const shim =
      '#!/bin/sh\nsleep 0.2\nif mkdir "$5.lock" 2>/dev/null; then printf PNG > "$5"; exit 0; fi\n' +
      "sleep 0.5\nexit 1\n";
    try {
      await withShimsAsync({ xcrun: shim }, async () => {
        const request = { action: "screenshot.capture", params: { udid: UDID, fileName } };
        const results = await Promise.all([
          runHostActionAsync(request, serveSimBin),
          runHostActionAsync(request, serveSimBin),
        ]);
        expect(results.map((r) => r.exitCode).sort()).toEqual([0, 1]);
      });
      expect(readFileSync(staged, "utf8")).toBe("PNG");
    } finally {
      rmSync(lock, { recursive: true, force: true });
      rmSync(staged, { force: true });
    }
  });

  it("sizes a thumbnail of the staged capture and reads it back as base64", async () => {
    await runHostActionAsync({ action: "screenshot.thumbnail", params: { fileName: SHOT } }, serveSimBin);
    const runs = loggedArgv();
    const sips = runs.filter((r) => r[0] === "sips").at(-1)!;
    expect(sips.slice(0, 5)).toEqual(["sips", "-Z", "320", STAGED, "--out"]);
    expect(sips[5]).toMatch(/serve-sim-uploads\/thumb-[0-9a-f-]+\.png$/);
    expect(runs.at(-1)?.slice(0, 2)).toEqual(["base64", "-i"]);
    expect(existsSync(sips[5]!)).toBe(false);
  });

  it("returns the first icon candidate that exists", async () => {
    const appPath = realpathSync(mkdtempSync(join(UPLOADS, "serve-sim-icon-")));
    try {
      writeFileSync(join(appPath, "Icon@2x.png"), "");
      const found = await runHostActionAsync(
        { action: "app.iconPath", params: { appPath, candidates: ["Icon@3x.png", "Icon@2x.png"] } },
        serveSimBin,
      );
      expect(found.exitCode).toBe(0);
      expect(found.stdout.trim()).toBe(join(appPath, "Icon@2x.png"));

      const missing = await runHostActionAsync(
        { action: "app.iconPath", params: { appPath, candidates: ["Icon@3x.png"] } },
        serveSimBin,
      );
      expect(missing.exitCode).toBe(1);
      expect(missing.stderr).toBe("no icon found");
    } finally {
      rmSync(appPath, { recursive: true, force: true });
    }
  });
});

describe("serve-sim-backed actions", () => {
  it("builds rotate and button", async () => {
    expect(await argv("rotate", { udid: UDID, value: "landscape" })).toEqual([
      "serve-sim", "rotate", "landscape", "-d", UDID,
    ]);
    expect(await argv("button", { value: "home", udid: UDID })).toEqual([
      "serve-sim", "button", "home", "-d", UDID,
    ]);
    expect(await argv("button", { value: "home" })).toEqual(["serve-sim", "button", "home"]);
  });

  it("builds server detach and kill", async () => {
    expect(await argv("server.detach", { udid: UDID, port: "3100" })).toEqual([
      "serve-sim", "--detach", UDID, "--port", "3100",
    ]);
    expect(await argv("server.detach", {})).toEqual(["serve-sim", "--detach"]);
    expect(await argv("server.kill", {})).toEqual(["serve-sim", "--kill"]);
  });

  it("builds the camera listing, mirror and stop", async () => {
    expect(await argv("camera.listWebcams", {})).toEqual([
      "serve-sim", "camera", "--list-webcams",
    ]);
    expect(await argv("camera.mirror", { udid: UDID, value: "on" })).toEqual([
      "serve-sim", "camera", "mirror", "on", "-d", UDID, "--quiet",
    ]);
    expect(await argv("camera.stopWebcam", { udid: UDID })).toEqual([
      "serve-sim", "camera", "--stop-webcam", "-d", UDID,
    ]);
  });

  it("builds camera switch for each source", async () => {
    expect(await argv("camera.switch", { udid: UDID, source: "placeholder" })).toEqual([
      "serve-sim", "camera", "switch", "placeholder", "-d", UDID, "--quiet",
    ]);
    expect(await argv("camera.switch", { udid: UDID, source: "file", target: CONFINED })).toEqual([
      "serve-sim", "camera", "switch", "file", CONFINED, "-d", UDID, "--quiet",
    ]);
    expect(
      await argv("camera.switch", { udid: UDID, source: "webcam", target: "Studio Display Camera" }),
    ).toEqual([
      "serve-sim", "camera", "switch", "webcam", "Studio Display Camera", "-d", UDID, "--quiet",
    ]);
  });

  it("builds camera inject for each source", async () => {
    expect(
      await argv("camera.inject", {
        udid: UDID, bundleId: BUNDLE, mirror: "off", source: "file", target: CONFINED,
      }),
    ).toEqual([
      "serve-sim", "camera", "enable", "-d", UDID, "--quiet", "--file", CONFINED, "--mirror", "off",
    ]);
    // A webcam with no name leaves --webcam bare, and the CLI reads the next "-" token as "no name".
    expect(
      await argv("camera.inject", {
        udid: UDID, bundleId: BUNDLE, mirror: "on", source: "webcam",
      }),
    ).toEqual([
      "serve-sim", "camera", "enable", "-d", UDID, "--quiet", "--webcam", "--mirror", "on",
    ]);
    expect(
      await argv("camera.inject", {
        udid: UDID, bundleId: BUNDLE, mirror: "on", source: "placeholder",
      }),
    ).toEqual(["serve-sim", "camera", "enable", "-d", UDID, "--quiet", "--mirror", "on"]);
  });

  it("builds the permission actions", async () => {
    expect(
      await argv("permissions.set", {
        udid: UDID, bundleId: BUNDLE, action: "grant", service: "camera",
      }),
    ).toEqual(["serve-sim", "permissions", "grant", "camera", BUNDLE, "-d", UDID]);
    expect(await argv("permissions.resetAll", { udid: UDID, bundleId: BUNDLE })).toEqual([
      "serve-sim", "permissions", "reset", "all", BUNDLE, "-d", UDID,
    ]);
  });
});
