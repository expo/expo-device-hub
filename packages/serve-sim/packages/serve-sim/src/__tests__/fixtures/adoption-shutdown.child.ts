import { expect, mock, test } from "bun:test";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { useTempStateDir } from "../helpers";
import * as commands from "../../simctl";

let calls: string[] = [];
let stopped = false;
let bootstatusFails = false;
let stop: () => Promise<void> = async () => {};
mock.module("../../simctl", () => ({
  ...commands,
  simctlSync: (args: string[]) => {
    calls.push(args.join(" "));
    return "";
  },
  simctl: async (args: string[]) => {
    calls.push(args.join(" "));
    if (args.join(" ") === "boot owned") return "";
    if (args.join(" ") === "bootstatus owned -b") {
      if (bootstatusFails) throw new Error("bootstatus failed");
      return "";
    }
    if (args.join(" ") === "list devices -j")
      return JSON.stringify({
        devices: { iOS: [{ udid: "owned", state: stopped ? "Shutdown" : "Booted" }] },
      });
    if (args.join(" ") === "shutdown owned") return await stop();
    throw new Error(`Unexpected native command: ${args.join(" ")}`);
  },
}));
const { releaseSession } = await import("../../launch-manager");

async function fixture(run: (dir: string) => Promise<void>) {
  const state = useTempStateDir();
  calls = [];
  stopped = false;
  bootstatusFails = false;
  retire = async () => {};
  stop = async () => {
    stopped = true;
  };
  writeFileSync(
    join(state.dir, "launch-owned.json"),
    JSON.stringify({
      sessionPids: [process.pid],
      launchArgs: [],
      capabilities: {
        clipboard: {
          name: "clipboard",
          dylib: "/owned/clipboard.dylib",
          scope: "allApps",
          ownerPid: process.pid,
        },
      },
    }),
  );
  writeFileSync(join(state.dir, "capabilities-owned.conf"), "original capability config");
  writeFileSync(join(state.dir, "capability-inserts-owned.json"), '["/owned/clipboard.dylib"]');
  try {
    await run(state.dir);
  } finally {
    state.restore();
  }
}

test("adoption release waits for native shutdown and confirms the stopped device", async () => {
  await fixture(async (dir) => {
    let entered!: () => void;
    const entering = new Promise<void>((resolve) => {
      entered = resolve;
    });
    let finish!: () => void;
    const gate = new Promise<void>((resolve) => {
      finish = resolve;
    });
    stop = async () => {
      entered();
      await gate;
      stopped = true;
    };
    let complete = false;
    const release = releaseSession("owned", process.pid, () => {}, { shutdown: true }).then(() => {
      complete = true;
    });
    await entering;
    try {
      expect(complete).toBe(false);
      expect(existsSync(join(dir, "launch-owned.json"))).toBe(true);
      expect(readFileSync(join(dir, "capabilities-owned.conf"), "utf8")).toBe(
        "original capability config",
      );
      expect(calls).toEqual(["shutdown owned"]);
    } finally {
      finish();
      await release;
    }
    expect(existsSync(join(dir, "launch-owned.json"))).toBe(false);
    expect(existsSync(join(dir, "capabilities-owned.conf"))).toBe(false);
    expect(readFileSync(join(dir, "capability-inserts-owned.json"), "utf8")).toBe("[]");
    expect(calls).toEqual(["shutdown owned", "list devices -j"]);
  });
});

test("adoption refuses successful shutdown commands that leave the device booted", async () => {
  await fixture(async (dir) => {
    const before = [
      "launch-owned.json",
      "capabilities-owned.conf",
      "capability-inserts-owned.json",
    ].map((name) => readFileSync(join(dir, name), "utf8"));
    stop = async () => {};
    await expect(
      releaseSession("owned", process.pid, () => {}, { shutdown: true }),
    ).rejects.toThrow("did not shut down");
    expect(
      ["launch-owned.json", "capabilities-owned.conf", "capability-inserts-owned.json"].map(
        (name) => readFileSync(join(dir, name), "utf8"),
      ),
    ).toEqual(before);
    expect(calls).toEqual(["shutdown owned", "list devices -j"]);
  });
});

test("adoption propagates a native shutdown failure", async () => {
  await fixture(async (dir) => {
    const before = [
      "launch-owned.json",
      "capabilities-owned.conf",
      "capability-inserts-owned.json",
    ].map((name) => readFileSync(join(dir, name), "utf8"));
    stop = async () => {
      throw new Error("shutdown rejected");
    };
    await expect(
      releaseSession("owned", process.pid, () => {}, { shutdown: true }),
    ).rejects.toThrow("shutdown rejected");
    expect(
      ["launch-owned.json", "capabilities-owned.conf", "capability-inserts-owned.json"].map(
        (name) => readFileSync(join(dir, name), "utf8"),
      ),
    ).toEqual(before);
    expect(calls).toEqual(["shutdown owned"]);
  });
});

test.each(["foreign session", "persistent capability", "malformed ownership", "foreign preview"])(
  "adoption preserves %s without native changes",
  async (kind) => {
    await fixture(async (dir) => {
      const launch = join(dir, "launch-owned.json");
      if (kind === "foreign session")
        writeFileSync(launch, JSON.stringify({ sessionPids: [process.ppid], capabilities: {} }));
      if (kind === "persistent capability")
        writeFileSync(launch, JSON.stringify({ capabilities: { camera: { ownerPid: null } } }));
      if (kind === "malformed ownership")
        writeFileSync(launch, JSON.stringify({ sessionPids: "invalid" }));
      if (kind === "foreign preview")
        writeFileSync(join(dir, "server-owned.json"), JSON.stringify({ pid: process.ppid }));
      await expect(
        releaseSession("owned", process.pid, () => {}, { shutdown: true }),
      ).rejects.toThrow();
      expect(existsSync(launch)).toBe(true);
      expect(calls).toEqual([]);
    });
  },
);

let retire: () => Promise<void> = async () => {};
const cleanupOrder: string[] = [];
mock.module("../../device-session", () => ({
  retireDeviceSession: async () => {
    await retire();
    cleanupOrder.push("native");
  },
}));
mock.module("../../capture", () => ({
  captureRuntime: {
    disableForDevice: async () => {
      cleanupOrder.push("capture");
    },
  },
}));
const { startDeviceInProcess, stopDeviceInProcess } = await import("../../device-lifecycle");

test("shared UI/adoption stop joins pending native consumers before shutdown", async () => {
  await fixture(async () => {
    cleanupOrder.length = 0;
    let finish!: () => void;
    const gate = new Promise<void>((resolve) => {
      finish = resolve;
    });
    retire = () => gate;
    let complete = false;
    const stopping = stopDeviceInProcess("owned", process.pid).then(() => {
      complete = true;
    });
    await Promise.resolve();
    expect(complete).toBe(false);
    expect(calls).toEqual([]);
    finish();
    await stopping;
    expect(cleanupOrder).toEqual(["native", "capture"]);
    expect(calls).toEqual(["shutdown owned", "list devices -j"]);
  });
});

test("shared stop preserves discovery and refuses shutdown after consumer cleanup fails", async () => {
  await fixture(async (dir) => {
    const discovery = join(dir, "server-owned.json");
    writeFileSync(discovery, JSON.stringify({ pid: process.pid }));
    retire = async () => {
      throw new Error("native cleanup failed");
    };
    await expect(stopDeviceInProcess("owned", process.pid)).rejects.toThrow(
      "native cleanup failed",
    );
    expect(existsSync(discovery)).toBe(true);
    expect(calls).toEqual([]);
  });
});

const { resolveDeviceMatches } = await import("../../device");
test("startup normalizes UDIDs before ownership and discovery publication", () => {
  expect(resolveDeviceMatches("aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee")).toEqual([
    "AAAAAAAA-BBBB-CCCC-DDDD-EEEEEEEEEEEE",
  ]);
});

test("grid shutdown still stops a Simulator served by a separate helper", async () => {
  await fixture(async (dir) => {
    const discovery = join(dir, "server-owned.json");
    writeFileSync(discovery, JSON.stringify({ pid: process.ppid }));
    await stopDeviceInProcess("owned");
    expect(stopped).toBe(true);
    expect(calls).toEqual(["shutdown owned"]);
    expect(existsSync(discovery)).toBe(true);
  });
});

test("UI startup recovers failed bootstatus when device readback is Booted", async () => {
  await fixture(async (dir) => {
    bootstatusFails = true;
    let configured = false;
    await startDeviceInProcess("owned", 3240, "/", undefined, "token", async () => {
      configured = true;
    });
    expect(configured).toBe(true);
    expect(existsSync(join(dir, "server-owned.json"))).toBe(true);
  });
});

test("adoption refuses failed bootstatus even when device state is Booted", async () => {
  await fixture(async (dir) => {
    bootstatusFails = true;
    let configured = false;
    await expect(
      startDeviceInProcess(
        "owned",
        3240,
        "/",
        undefined,
        "token",
        async () => {
          configured = true;
        },
        { requireReady: true },
      ),
    ).rejects.toThrow("bootstatus failed");
    expect(configured).toBe(false);
    expect(existsSync(join(dir, "server-owned.json"))).toBe(false);
  });
});

test("UI startup rejects failed bootstatus when readback is not Booted", async () => {
  await fixture(async (dir) => {
    bootstatusFails = true;
    stopped = true;
    await expect(startDeviceInProcess("owned", 3240, "/")).rejects.toThrow("bootstatus failed");
    expect(existsSync(join(dir, "server-owned.json"))).toBe(false);
  });
});

test("grid shutdown preserves network capture when the Simulator refuses shutdown", async () => {
  await fixture(async () => {
    cleanupOrder.length = 0;
    stop = async () => {
      throw new Error("shutdown refused");
    };
    await expect(stopDeviceInProcess("owned")).rejects.toThrow("shutdown refused");
    expect(cleanupOrder).toEqual(["native"]);
    expect(calls).toEqual(["shutdown owned"]);
  });
});
