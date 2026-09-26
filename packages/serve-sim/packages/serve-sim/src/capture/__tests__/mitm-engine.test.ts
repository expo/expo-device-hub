import { chmodSync, existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { describe, expect, test } from "bun:test";

import {
  DEFAULT_MAX_CONTROL_BODY_BYTES,
  describeFailure,
  formatOversizedControlBodyWarning,
  locateMitmdump,
  maxControlBodyBytes,
  sweepStaleConfdirs,
  mitmdumpMissingMessage,
  parseMitmPids,
  startMitmProxy,
} from "../mitm-engine";
import { CaptureStore } from "../store";

const MARKER = "serve-sim-capture-Qz7pLm";
const SELF = 400;

const psFixture = [
  `  ${SELF} bun run serve-sim --udid ABC ${MARKER}`,
  `  7101 /x/mitmproxy.app/Contents/MacOS/mitmdump -q --listen-port 5555 --set confdir=/var/T/${MARKER}`,
  `  7102 /x/mitmproxy.app/Contents/Frameworks/Python --set confdir=/var/T/${MARKER} -s servesim_capture.py`,
  "  7103 /opt/homebrew/bin/mitmdump --set confdir=/Users/gabe/.mitmproxy",
  "  7104 /Applications/Safari.app/Contents/MacOS/Safari",
].join("\n");

describe("parseMitmPids", () => {
  test("finds every process started with this session's confdir", () => {
    expect(parseMitmPids(psFixture, MARKER, SELF)).toEqual([7101, 7102]);
  });

  test("leaves a mitmproxy the developer runs themselves alone", () => {
    // 7103 is on the default confdir; killing it would take down their own debugging session.
    expect(parseMitmPids(psFixture, MARKER, SELF)).not.toContain(7103);
  });

  test("never returns our own pid, even though the marker is in our command line", () => {
    expect(parseMitmPids(psFixture, MARKER, SELF)).not.toContain(SELF);
  });

  test("returns nothing when no process matches, so a second shutdown is harmless", () => {
    expect(parseMitmPids(psFixture, "serve-sim-capture-Nope00", SELF)).toEqual([]);
    expect(parseMitmPids("", MARKER, SELF)).toEqual([]);
  });

  test("ignores lines carrying the marker without a parsable pid", () => {
    const noisy = [`  not-a-pid ${MARKER}`, `  7200 mitmdump ${MARKER}`].join("\n");
    expect(parseMitmPids(noisy, MARKER, SELF)).toEqual([7200]);
  });
});

describe("locateMitmdump", () => {
  /** Runs a case with SERVE_SIM_MITMDUMP controlled, so a developer's own env can't change the result. */
  function withOverride<T>(value: string | undefined, body: () => T): T {
    const previous = process.env.SERVE_SIM_MITMDUMP;
    if (value === undefined) delete process.env.SERVE_SIM_MITMDUMP;
    else process.env.SERVE_SIM_MITMDUMP = value;
    try {
      return body();
    } finally {
      if (previous === undefined) delete process.env.SERVE_SIM_MITMDUMP;
      else process.env.SERVE_SIM_MITMDUMP = previous;
    }
  }

  test("prefers whatever is on PATH, which is where brew puts it", () => {
    withOverride(undefined, () => {
      expect(locateMitmdump({ which: () => "/opt/homebrew/bin/mitmdump" })).toBe(
        "/opt/homebrew/bin/mitmdump",
      );
    });
  });

  test("reports nothing when the developer has no mitmproxy at all", () => {
    withOverride(undefined, () => {
      expect(locateMitmdump({ which: () => null, candidates: ["/nope/mitmdump"] })).toBeNull();
    });
  });

  test("rejects an override pointing at a path that does not exist", () => {
    withOverride("/nope/mitmdump", () => {
      // Honouring it blindly would produce a spawn error instead of a message the developer can act on.
      expect(locateMitmdump({ which: () => "/opt/homebrew/bin/mitmdump", candidates: [] })).toBeNull();
    });
  });

  test("honours an override that does exist, ahead of anything on PATH", () => {
    withOverride("/bin/sh", () => {
      expect(locateMitmdump({ which: () => "/opt/homebrew/bin/mitmdump" })).toBe("/bin/sh");
    });
  });
});

describe("mitmdumpMissingMessage", () => {
  test("says what is missing, why it isn't bundled, and the command that fixes it", () => {
    const message = mitmdumpMissingMessage();
    expect(message).toContain("brew install mitmproxy");
    expect(message).toContain("mitmproxy.org/downloads");
    // The escape hatch matters for anyone whose install is somewhere unusual.
    expect(message).toContain("SERVE_SIM_MITMDUMP");
  });
});

describe("maxControlBodyBytes", () => {
  function withEnv<T>(value: string | undefined, body: () => T): T {
    const key = "SERVE_SIM_CAPTURE_MAX_CONTROL_BODY_BYTES";
    const previous = process.env[key];
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
    try {
      return body();
    } finally {
      if (previous === undefined) delete process.env[key];
      else process.env[key] = previous;
    }
  }

  test("defaults to 10 MiB", () => {
    withEnv(undefined, () => {
      expect(maxControlBodyBytes()).toBe(DEFAULT_MAX_CONTROL_BODY_BYTES);
      expect(DEFAULT_MAX_CONTROL_BODY_BYTES).toBe(10 * 1024 * 1024);
    });
  });

  test("honours a positive integer override", () => {
    withEnv("1048576", () => {
      expect(maxControlBodyBytes()).toBe(1_048_576);
    });
  });

  test("ignores blank or non-positive values", () => {
    withEnv(" ", () => expect(maxControlBodyBytes()).toBe(DEFAULT_MAX_CONTROL_BODY_BYTES));
    withEnv("0", () => expect(maxControlBodyBytes()).toBe(DEFAULT_MAX_CONTROL_BODY_BYTES));
    withEnv("-1", () => expect(maxControlBodyBytes()).toBe(DEFAULT_MAX_CONTROL_BODY_BYTES));
    withEnv("nope", () => expect(maxControlBodyBytes()).toBe(DEFAULT_MAX_CONTROL_BODY_BYTES));
  });
});

describe("formatOversizedControlBodyWarning", () => {
  test("names the path, sizes, and env override so a greppable terminal line diagnoses repeats", () => {
    const message = formatOversizedControlBodyWarning({
      bytesSeen: 11_000_000,
      limit: 10_485_760,
      path: "/response",
    });
    expect(message).toContain("[capture] Dropped oversized control body");
    expect(message).toContain("/response");
    expect(message).toContain("11000000");
    expect(message).toContain("SERVE_SIM_CAPTURE_MAX_CONTROL_BODY_BYTES");
  });
});

describe("describeFailure", () => {
  test("explains a refused connection", () => {
    const out = describeFailure("[Errno 61] Connect call failed ('127.0.0.1', 9)");
    expect(out).toContain("Nothing was listening");
    // The raw text is kept, so the detail is not lost.
    expect(out).toContain("Errno 61");
  });

  test("explains an unresolvable host", () => {
    expect(describeFailure("[Errno 8] nodename nor servname provided, or not known")).toContain(
      "could not be resolved",
    );
  });

  test("names certificate pinning, which is the one a developer will hit and misread", () => {
    expect(describeFailure("Client TLS handshake failed: certificate verify failed")).toContain("pin");
  });

  test("passes an unrecognised reason through rather than inventing one", () => {
    expect(describeFailure("something entirely new")).toBe("something entirely new");
  });
});

test("proxy startup retries address conflicts and cleans every attempt", async () => {
  const dir = mkdtempSync(join(tmpdir(), "serve-sim-mitm-retry-"));
  const executable = join(dir, "mitmdump");
  const attempts = join(dir, "attempts");
  const paths = join(dir, "paths");
  writeFileSync(
    executable,
    `#!/usr/bin/env bun
import { appendFileSync, readFileSync, writeFileSync } from "node:fs";
const attempts = process.env.SERVE_SIM_TEST_ATTEMPTS;
const paths = process.env.SERVE_SIM_TEST_PATHS;
const count = Number(readFileSync(attempts, "utf8") || "0") + 1;
writeFileSync(attempts, String(count));
const confdir = process.argv.find((arg) => arg.startsWith("confdir="))?.slice("confdir=".length);
appendFileSync(paths, confdir + "\\n");
if (count < 3) {
  console.error("Address already in use");
  process.exit(1);
}
writeFileSync(confdir + "/mitmproxy-ca-cert.pem", "test-ca");
await fetch(process.env.SERVE_SIM_CAPTURE_CONTROL_URL + "/ready?t=" + process.env.SERVE_SIM_CAPTURE_CONTROL_TOKEN, {
  method: "POST",
  body: "{}",
});
setInterval(() => {}, 1000);
`,
  );
  chmodSync(executable, 0o755);
  writeFileSync(attempts, "0");
  writeFileSync(paths, "");

  const previous = {
    executable: process.env.SERVE_SIM_MITMDUMP,
    attempts: process.env.SERVE_SIM_TEST_ATTEMPTS,
    paths: process.env.SERVE_SIM_TEST_PATHS,
  };
  process.env.SERVE_SIM_MITMDUMP = executable;
  process.env.SERVE_SIM_TEST_ATTEMPTS = attempts;
  process.env.SERVE_SIM_TEST_PATHS = paths;
  let unexpectedExits = 0;
  try {
    const proxy = await startMitmProxy(new CaptureStore(), {
      onUnexpectedExit: () => unexpectedExits++,
    });
    await proxy.close();
    expect(readFileSync(attempts, "utf8")).toBe("3");
    expect(unexpectedExits).toBe(0);
    for (const path of readFileSync(paths, "utf8").trim().split("\n")) {
      expect(existsSync(path)).toBe(false);
    }
  } finally {
    if (previous.executable === undefined) delete process.env.SERVE_SIM_MITMDUMP;
    else process.env.SERVE_SIM_MITMDUMP = previous.executable;
    if (previous.attempts === undefined) delete process.env.SERVE_SIM_TEST_ATTEMPTS;
    else process.env.SERVE_SIM_TEST_ATTEMPTS = previous.attempts;
    if (previous.paths === undefined) delete process.env.SERVE_SIM_TEST_PATHS;
    else process.env.SERVE_SIM_TEST_PATHS = previous.paths;
    rmSync(dir, { recursive: true, force: true });
  }
});

describe("sweepStaleConfdirs", () => {
  const dirs = ["/tmp/serve-sim-capture-live", "/tmp/serve-sim-capture-dead", "/tmp/serve-sim-capture-new"];
  const ages: Record<string, number> = {
    "/tmp/serve-sim-capture-live": 600_000,
    "/tmp/serve-sim-capture-dead": 600_000,
    "/tmp/serve-sim-capture-new": 1_000,
  };

  function sweep(psOutput: () => string | null) {
    const removed: string[] = [];
    const swept = sweepStaleConfdirs({
      list: () => dirs,
      remove: (dir) => void removed.push(dir),
      psOutput,
      ageMs: (dir) => ages[dir]!,
    });
    return { swept, removed };
  }

  test("removes only old confdirs that no running mitmdump names", () => {
    const { swept, removed } = sweep(() => "123 mitmdump --set confdir=/tmp/serve-sim-capture-live\n");
    expect(removed).toEqual(["/tmp/serve-sim-capture-dead"]);
    expect(swept).toBe(1);
  });

  test("keeps every confdir when processes cannot be listed", () => {
    expect(sweep(() => null)).toEqual({ swept: 0, removed: [] });
  });
});
