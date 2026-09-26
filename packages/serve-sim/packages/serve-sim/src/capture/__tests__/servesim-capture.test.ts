import { spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

import { describe, expect, test } from "bun:test";

import { locateMitmdump } from "../mitm-engine";

const ADDON = resolve(import.meta.dir, "../mitm-addon/servesim_capture.py");
const PROBE = resolve(import.meta.dir, "fixtures/servesim-capture-probe.py");
const BROTLI_PROBE = resolve(import.meta.dir, "fixtures/servesim-capture-brotli-probe.py");

function python(): string | null {
  for (const candidate of ["python3", "/usr/bin/python3"]) {
    const probe = spawnSync(candidate, ["--version"], { stdio: "pipe" });
    if (probe.status === 0) return candidate;
  }
  return null;
}

const PYTHON = python();
const describeOrSkip = PYTHON && existsSync(ADDON) ? describe : describe.skip;
if (!PYTHON) console.warn("[servesim_capture] skipping: no python3 on this host");

/** Every probe assertion comes from one addon instance, so the module state is shared as in production. */
function runProbe(): Record<string, unknown> {
  const result = spawnSync(PYTHON!, [PROBE, ADDON], { stdio: "pipe", encoding: "utf8" });
  if (result.status !== 0) {
    throw new Error(`probe failed (${result.status}):\n${result.stderr || result.stdout}`);
  }
  return JSON.parse(result.stdout.trim().split("\n").at(-1)!);
}

describeOrSkip("servesim_capture addon", () => {
  const probe = PYTHON ? runProbe() : {};

  test("reports the proxy's original request time in milliseconds", () => {
    expect(probe.requestStartedAt).toBe(1_000_000);
  });

  test("keeps the wire bytes of a body without a content-encoding", () => {
    expect(probe.plainSize).toBe(90);
    expect(probe.plainBody).toBe("gzipbytes".repeat(10));
  });

  test("never decodes a body it was not asked to keep", () => {
    expect(probe.metadataBody).toBe("");
    expect(probe.metadataDecoded).toBe(false);
  });

  test("decodes gzip and deflate bodies so they read as text, and reports wire size", () => {
    expect(probe.gzipBody).toBe('{"ok":true}');
    expect(probe.gzipSize).toBe(true);
    expect(probe.gzipTruncated).toBe(false);
    expect(probe.deflateBodies).toEqual(["zlib deflate", "raw deflate"]);
  });

  test("stops decoding a compressed body at the cap instead of inflating all of it", () => {
    expect(probe.bombBodyLength).toBe(512 * 1024);
    expect(probe.bombTruncated).toBe(true);
    expect(probe.bombSize).toBe(true);
    expect(probe.bombDecodedBytes).toBe(512 * 1024 + 1);
  });

  test("marks a compressed body that ends early as incomplete", () => {
    expect(probe.cutBody).toBe('{"a":1,"b":"text"');
    expect(probe.cutTruncated).toBe(true);
  });

  test("marks data after the first gzip member as not shown", () => {
    expect(probe.membersBody).toBe("first member ");
    expect(probe.membersTruncated).toBe(true);
  });

  test("falls back to the wire bytes for an encoding it does not decode", () => {
    expect(probe.unsupportedBase64).toBe("//4=");
  });

  test("survives a body whose content-encoding does not match its bytes", () => {
    // A decode error must not kill the hook, which would leave the row in flight forever.
    expect(probe.lyingBody).toBe("raw-wire-bytes");
    expect(probe.lyingSize).toBe(14);
  });

  test("sends binary bodies as base64 rather than mojibake", () => {
    expect(probe.binaryBody).toBeNull();
    expect(probe.binaryBase64).toBe("//4AAQ==");
  });

  test("caps a body at the per-body limit and says it was cut", () => {
    expect(probe.oversizedTruncated).toBe(true);
    expect(probe.oversizedBodyLength).toBe(512 * 1024);
  });

  test("keeps a text body readable when the cap splits a multibyte character", () => {
    expect(probe.splitCharBody).toBe(512 * 1024 - 1);
    expect(probe.splitCharBase64).toBeNull();
    expect(probe.splitCharTruncated).toBe(true);
  });

  test("reports an absent body as empty rather than as a cut one", () => {
    expect(probe.emptySize).toBe(0);
    expect(probe.emptyBody).toBe("");
    expect(probe.emptyTruncated).toBe(false);
  });

  test("lowercases header names, which the session looks up in lower case", () => {
    expect(probe.headerKeys).toEqual(["content-type"]);
  });

  test("announces itself so readiness proves the hooks are installed", () => {
    expect(probe.readyDelivered).toBe(true);
    expect(probe.readyPath).toBe("/ready?t=probe-token");
  });

  test("ignores a configured http_proxy when reporting", () => {
    expect(probe.proxyBypassed).toBe(true);
  });

  test("does not report a second row when a completed response already reported one", () => {
    expect(probe.errorSkippedWhenResponseCompleted).toBe(true);
  });

  test("settles a row whose response started and then died mid-body", () => {
    // Skipping on any response at all left these rows started forever: no status, no failure.
    expect(probe.errorAfterPartialResponseFrames).toBe(1);
    expect(probe.errorAfterPartialResponseStatus).toBeNull();
    expect(probe.errorAfterPartialResponseMessage).toBe("server closed the connection");
  });

  test("opens and settles a row for a CONNECT that never established", () => {
    expect(probe.connectErrorFrames).toBe(2);
    expect(probe.connectErrorPaths).toEqual(["/request", "/response"]);
  });

  test("releases queued bytes as records drain", () => {
    expect(probe.queuedBytesAfterDrain).toBe(0);
  });

  test("drops a record rather than queueing past the byte limit", () => {
    expect(probe.oversizedRecordDropped).toBe(true);
    // A dropped record must not leave its size behind, or the limit creeps shut.
    expect(probe.queuedBytesAfterDrop).toBe(0);
  });

  test("shuts down cleanly when it was loaded without a control url", () => {
    const result = spawnSync(
      PYTHON!,
      [
        "-c",
        [
          "import importlib.util, os, sys",
          "os.environ.pop('SERVE_SIM_CAPTURE_CONTROL_URL', None)",
          `spec = importlib.util.spec_from_file_location('servesim_capture', ${JSON.stringify(ADDON)})`,
          "addon = importlib.util.module_from_spec(spec)",
          "spec.loader.exec_module(addon)",
          "addon.done()",
          "print('ok')",
        ].join("\n"),
      ],
      { stdio: "pipe", encoding: "utf8" },
    );
    expect(result.stderr).not.toContain("RuntimeError");
    expect(result.status).toBe(0);
  });

  test("redacts query values but keeps their names, so requests stay distinguishable", () => {
    // A URL alone carries OAuth codes, signed-URL keys and reset tokens; header redaction never saw them.
    expect(probe.urlQueryRedacted).toBe("https://a.test/cb?code=[REDACTED]&state=[REDACTED]");
  });

  test("leaves a URL without a query alone", () => {
    expect(probe.urlWithoutQueryUntouched).toBe("https://a.test/thing");
  });

  test("caps a URL whose redaction makes it longer, not just one long value", () => {
    expect(probe.urlCappedExpanding).toBe(true);
    expect(probe.urlCapped).toBe(true);
  });

  test("redacts a bare query token, which is the whole credential", () => {
    expect(probe.urlBareTokenRedacted).toBe("https://a.test/cb?[REDACTED]");
  });

  test("counts a bodyless record against the queue limit", () => {
    // Body-only accounting sized this at zero, so a large URL or header set was unbounded.
    expect(probe.bodylessRecordCounted).toBe(true);
  });

  test("reports a request that failed before any response", () => {
    expect(probe.errorWithoutResponseFrames).toBe(1);
    expect(probe.errorWithoutResponseMessage).toBe("connection reset");
  });
});

const MITMDUMP = locateMitmdump();
const describeUnderMitmproxy = MITMDUMP && existsSync(ADDON) ? describe : describe.skip;
if (!MITMDUMP) console.warn("[servesim_capture] skipping brotli: no mitmdump on this host");

describeUnderMitmproxy("servesim_capture addon under mitmproxy's own Python", () => {
  test("decodes brotli bodies and stops a brotli bomb at the cap", () => {
    const dir = mkdtempSync(join(tmpdir(), "serve-sim-brotli-probe-"));
    const out = join(dir, "result.json");
    try {
      const run = spawnSync(MITMDUMP!, ["-q", "--set", "server=false", "-s", BROTLI_PROBE], {
        env: { ...process.env, SERVE_SIM_ADDON_PATH: ADDON, SERVE_SIM_BROTLI_PROBE_OUT: out },
        encoding: "utf8",
        timeout: 60_000,
      });
      expect(existsSync(out), run.stderr || run.stdout).toBe(true);
      expect(JSON.parse(readFileSync(out, "utf8"))).toEqual({
        textBody: '{"hello":"brotli"}',
        textTruncated: false,
        bombBodyLength: 512 * 1024,
        bombTruncated: true,
        garbageBase64: "//5ub3QtYnJvdGxp",
      });
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  }, 90_000);
});
