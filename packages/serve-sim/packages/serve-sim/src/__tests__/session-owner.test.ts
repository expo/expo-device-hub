import { expect, test } from "bun:test";
import { createConnection } from "net";
import { chmodSync, existsSync, readFileSync, rmSync, symlinkSync, unlinkSync } from "fs";
import { basename, join, resolve } from "path";
import { tmpdir } from "os";
import {
  adoptSession,
  bootSession,
  sessionEnvironment,
  sessionOwnerFile,
  startSessionOwner,
  type SessionIdentity,
} from "../session-owner";
import { type SessionConfiguration } from "../session-configuration";
import { DEFAULT_STREAM_ENCODER_SETTINGS } from "../stream-settings";
import { inProcessServeSimState, listStateFiles, stateDir, writeServeSimState } from "../state";
import { ConfinedPath } from "../host-paths";
import { UDID, useTempStateDir } from "./helpers";

const configuration: SessionConfiguration = {
  stream: { transport: "webrtc", codec: "h264", ...DEFAULT_STREAM_ENCODER_SETTINGS },
  corsOrigins: [],
  frameAncestors: [],
  disableShare: false,
  networkCapture: true,
  networkCaptureFields: ["header", "query"],
  networkCaptureProxy: "http://127.0.0.1:8080",
};

function request(path: string, body: object): Promise<Record<string, unknown>> {
  return new Promise((resolve, reject) => {
    const socket = createConnection(path);
    let data = "";
    socket.setTimeout(3000, () => socket.destroy(new Error("test owner request timed out")));
    socket.on("error", reject);
    socket.once("connect", () => socket.write(JSON.stringify(body) + "\n"));
    socket.on("data", (chunk) => {
      data += chunk;
      if (!data.includes("\n")) return;
      socket.destroy();
      resolve(JSON.parse(data));
    });
  });
}

async function fixture(
  configure: (value: SessionConfiguration) => Promise<void>,
  run: (value: {
    identity: SessionIdentity;
    directory: string;
    socket: string;
    secret: string;
    adopt(): Promise<unknown>;
  }) => Promise<void>,
) {
  const state = useTempStateDir();
  const discoveryDirectory = join(tmpdir(), "serve-sim-uploads", basename(state.dir));
  process.env.SERVE_SIM_STATE_DIR = discoveryDirectory;
  const identity: SessionIdentity = {
    version: "fixture",
    pid: process.pid,
    device: UDID,
    bootSession: bootSession(),
    host: "127.0.0.1",
    port: 3200,
    stateDirectory: resolve(stateDir()),
    temporaryDirectory: resolve(tmpdir()),
    environment: sessionEnvironment(),
  };
  const owner = await startSessionOwner(UDID, () => identity, configure);
  writeServeSimState({ ...inProcessServeSimState(UDID, 3200), token: "preview-token" });
  const { directory } = JSON.parse(readFileSync(sessionOwnerFile(UDID), "utf8"));
  try {
    await run({
      identity,
      directory,
      socket: join(directory, "control.sock"),
      secret: readFileSync(join(directory, "authority"), "utf8"),
      adopt: () => adoptSession(UDID, "fixture", "127.0.0.1", 3200, configuration),
    });
  } finally {
    owner.close();
    rmSync(discoveryDirectory, { recursive: true, force: true });
    state.restore();
  }
}

test("local authority stays outside HTTP file roots and public device state", async () => {
  await fixture(
    async () => {},
    async ({ directory }) => {
      expect(ConfinedPath.safeParse(sessionOwnerFile(UDID)).success).toBe(true);
      expect(ConfinedPath.safeParse(join(directory, "authority")).success).toBe(false);
      expect(readFileSync(sessionOwnerFile(UDID), "utf8")).not.toContain("secret");
      expect(listStateFiles()).toHaveLength(1);
      const state = JSON.parse(readFileSync(listStateFiles()[0]!, "utf8"));
      expect(JSON.stringify(state)).not.toContain(directory);
    },
  );
});

test("the preview token is not owner authority, and refusal does not consume adoption", async () => {
  let calls = 0;
  await fixture(
    async () => {
      calls++;
    },
    async ({ socket, identity, adopt, directory }) => {
      const refused = await request(socket, {
        secret: "preview-token",
        method: "configure",
        identity,
        configuration,
      });
      expect(refused).toEqual({ ok: false, error: "local_owner_required" });
      expect(calls).toBe(0);
      await adopt();
      expect(calls).toBe(1);
      expect(existsSync(directory)).toBe(false);
      await expect(adopt()).rejects.toThrow();
    },
  );
});

test("identity mismatches are checked again at the atomic claim", async () => {
  let calls = 0;
  await fixture(
    async () => {
      calls++;
    },
    async ({ socket, secret, identity, adopt }) => {
      expect(
        await request(socket, {
          secret,
          method: "configure",
          identity: { ...identity, bootSession: "stale" },
          configuration,
        }),
      ).toEqual({ ok: false, error: "incompatible_session" });
      expect(calls).toBe(0);
      await adopt();
      expect(calls).toBe(1);
    },
  );
});

test("one CLI claim waits for capture configuration and excludes competing claims", async () => {
  let enter!: () => void, release!: () => void;
  const entered = new Promise<void>((resolve) => {
    enter = resolve;
  });
  const ready = new Promise<void>((resolve) => {
    release = resolve;
  });
  let completed = false;
  await fixture(
    async (value) => {
      expect(value.networkCapture).toBe(true);
      expect(value.networkCaptureFields).toEqual(["header", "query"]);
      expect(value.networkCaptureProxy).toBe("http://127.0.0.1:8080");
      enter();
      await ready;
    },
    async ({ adopt }) => {
      const first = adopt().then(() => {
        completed = true;
      });
      await entered;
      expect(completed).toBe(false);
      await expect(adopt()).rejects.toThrow();
      release();
      await first;
      expect(completed).toBe(true);
    },
  );
});

test("failed native setup consumes the claim instead of allowing reconfiguration", async () => {
  let calls = 0;
  await fixture(
    async () => {
      calls++;
      throw new Error("capture failed");
    },
    async ({ adopt }) => {
      await expect(adopt()).rejects.toThrow("session_configuration_failed");
      await expect(adopt()).rejects.toThrow();
      expect(calls).toBe(1);
    },
  );
});

test("rejects permissive and symlinked authority files before connecting", async () => {
  await fixture(
    async () => {
      throw new Error("must not configure");
    },
    async ({ directory, adopt }) => {
      const authority = join(directory, "authority");
      chmodSync(authority, 0o644);
      await expect(adopt()).rejects.toThrow("owner file");
      unlinkSync(authority);
      symlinkSync(sessionOwnerFile(UDID), authority);
      await expect(adopt()).rejects.toThrow();
    },
  );
});

test("invalid configuration consumes an authenticated claim without applying it", async () => {
  let calls = 0;
  await fixture(
    async () => {
      calls++;
    },
    async ({ socket, secret, identity, adopt }) => {
      expect(
        await request(socket, {
          secret,
          method: "configure",
          identity,
          configuration: { ...configuration, unexpected: true },
        }),
      ).toEqual({ ok: false, error: "session_configuration_failed" });
      expect(calls).toBe(0);
      await expect(adopt()).rejects.toThrow();
    },
  );
});

test("HTTP file paths deny authority even when a staging root resolves to /tmp", async () => {
  const { runChildSuite } = await import("./fixtures/run-child-suite");
  const { exitCode, output } = await runChildSuite("session-owner-paths.child.ts");
  expect(exitCode, output).toBe(0);
});
