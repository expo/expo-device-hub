import { expect, test } from "bun:test";
import { spawn } from "child_process";
import { existsSync, readFileSync } from "fs";
import { join } from "path";
import { capabilityConfigPath, readLaunchState } from "../launch-manager";
import { useTempStateDir, withShimsAsync } from "./helpers";

type Probe = {
  signal: "SIGINT" | "SIGTERM";
  host?: "before" | "after" | "during";
  capture?: "before" | "after";
  update?: "finishes" | "stalls" | "slow-native";
  slowDisarm?: boolean;
  repeat?: boolean;
  releaseOnSignal?: boolean;
};

async function stopEmbeddedHost({ signal, host, capture, update, slowDisarm, repeat, releaseOnSignal }: Probe) {
  const state = useTempStateDir();
  const udid = `EMBEDDED-CLEANUP-${process.pid}`;
  const ready = join(state.dir, "ready");
  const handled = join(state.dir, "handled");
  const hostStatus = join(state.dir, "host-status");
  const reaped = join(state.dir, "reaped");
  const completed = join(state.dir, "completed");
  const refused = join(state.dir, "refused");
  const cleanupPid = join(state.dir, "cleanup-pid");
  const lateMutation = join(state.dir, "late-mutation");
  const initialPublication = join(state.dir, "initial-publication");
  const manager = join(import.meta.dir, "../launch-manager.ts");
  const clipboard = join(import.meta.dir, "../sim-pasteboard-reader.ts");
  const engine = join(import.meta.dir, "../capture/mitm-engine.ts");
  try {
    const xcrun = slowDisarm || update === "slow-native" ? `#!${process.execPath}
      import { existsSync, writeFileSync } from "fs";
      if (${slowDisarm ? 'process.argv.includes("unsetenv")' : `process.argv.includes("setenv") && process.argv.includes("SERVE_SIM_CAPABILITIES_CONFIG") && existsSync(${JSON.stringify(initialPublication)})`}) {
        writeFileSync(${JSON.stringify(cleanupPid)}, String(process.pid));
        ${update === "slow-native" ? `writeFileSync(${JSON.stringify(ready)}, "ready");` : ""}
        await Bun.sleep(20_000);
        writeFileSync(${JSON.stringify(lateMutation)}, "mutated");
      }
    ` : "#!/bin/sh\nexit 0\n";
    await withShimsAsync({ xcrun }, async () => {
      const child = spawn(process.execPath, ["-e", `
        const { appendFileSync, writeFileSync } = await import("fs");
        const { setCapabilityEnabled, readLaunchState, releaseSession } = await import(${JSON.stringify(manager)});
        const { clipboardCapability } = await import(${JSON.stringify(clipboard)});
        const installHost = () => process.on(${JSON.stringify(signal)}, () => {
          appendFileSync(${JSON.stringify(handled)}, ${JSON.stringify("handled\n")});
          ${releaseOnSignal ? `void releaseSession(${JSON.stringify(udid)}, process.pid, () => {});` : ""}
          setTimeout(() => {
            writeFileSync(${JSON.stringify(hostStatus)}, readLaunchState(${JSON.stringify(udid)})?.capabilities.clipboard ? "retained" : "released");
            process.exit(23);
          }, 100);
        });
        const installCapture = async () => {
          const { captureReapersForTest } = await import(${JSON.stringify(engine)});
          captureReapersForTest.add(() => appendFileSync(${JSON.stringify(reaped)}, ${JSON.stringify("reaped\n")}));
        };
        ${host === "before" ? "installHost();" : ""}
        ${capture === "before" ? "await installCapture();" : ""}
        await setCapabilityEnabled(${JSON.stringify(udid)}, clipboardCapability, { enabled: true, relaunch: false });
        writeFileSync(${JSON.stringify(initialPublication)}, "ready");
        ${host === "after" ? "installHost();" : ""}
        ${host === "during" ? "setTimeout(installHost, 100);" : ""}
        ${capture === "after" ? "await installCapture();" : ""}
        setInterval(() => {}, 1000);
        ${update ? `
          void setCapabilityEnabled(${JSON.stringify(udid)}, {
            ...clipboardCapability,
            async setEnabled() {
              ${update !== "slow-native" ? `writeFileSync(${JSON.stringify(ready)}, "ready");` : ""}
              ${update === "stalls" ? "await new Promise(() => {});" : update === "finishes" ? `
                await new Promise((resolve) => setTimeout(resolve, 250));
                try {
                  await setCapabilityEnabled(${JSON.stringify(udid)}, clipboardCapability, { enabled: true, relaunch: false });
                } catch { writeFileSync(${JSON.stringify(refused)}, "refused"); }
                writeFileSync(${JSON.stringify(completed)}, "completed");
              ` : ""}
              return { dylib: "/probe.dylib" };
            },
          }, { enabled: true, relaunch: false, reuseIfEnabled: true }).catch(() => {});
        ` : `writeFileSync(${JSON.stringify(ready)}, "ready");`}
      `], { stdio: ["ignore", "ignore", "pipe"], env: { ...process.env } });
      let stderr = "";
      child.stderr?.on("data", (chunk: Buffer) => { stderr += chunk.toString(); });
      const exited = new Promise<{ code: number | null; signal: NodeJS.Signals | null }>((resolve, reject) => {
        child.once("error", reject);
        child.once("close", (code, signal) => resolve({ code, signal }));
      });
      let exitTimeout: ReturnType<typeof setTimeout> | undefined;
      try {
        const deadline = Date.now() + 3000;
        while (!existsSync(ready) && Date.now() < deadline) await Bun.sleep(5);
        expect(existsSync(ready)).toBe(true);
        expect(child.kill(signal)).toBe(true);
        if (repeat) {
          await Bun.sleep(25);
          expect(child.kill(signal)).toBe(true);
        }
        const result = await Promise.race([
          exited,
          new Promise<never>((_, reject) => {
            exitTimeout = setTimeout(() => reject(new Error(`Embedded host did not stop: ${stderr}`)), 12_000);
          }),
        ]);
        expect(result).toEqual(host ? { code: 23, signal: null } : { code: null, signal });
        if (host) {
          expect(readFileSync(handled, "utf8")).toBe("handled\n");
          expect(readFileSync(hostStatus, "utf8")).toBe(host === "during" || releaseOnSignal ? "released" : "retained");
        }
        if (capture) expect(readFileSync(reaped, "utf8")).toBe("reaped\n");
        if (update === "finishes") {
          expect(existsSync(completed)).toBe(true);
          expect(existsSync(refused)).toBe(true);
        }
        if (slowDisarm || update === "slow-native") {
          const pid = Number(readFileSync(cleanupPid, "utf8"));
          const goneDeadline = Date.now() + 500;
          let running = true;
          while (running && Date.now() < goneDeadline) {
            try { process.kill(pid, 0); } catch { running = false; }
            if (running) await Bun.sleep(5);
          }
          expect(running).toBe(false);
          expect(existsSync(lateMutation)).toBe(false);
        }
        if (update !== "slow-native") {
          expect(existsSync(capabilityConfigPath(udid))).toBe(update === "stalls" || !!slowDisarm);
          if (update !== "stalls") expect(readLaunchState(udid)).toBeNull();
        }
      } finally {
        clearTimeout(exitTimeout);
        child.kill("SIGKILL");
        await exited;
        if (existsSync(cleanupPid)) {
          try { process.kill(Number(readFileSync(cleanupPid, "utf8")), "SIGKILL"); } catch {}
        }
      }
    });
  } finally {
    state.restore();
  }
}

for (const signal of ["SIGINT", "SIGTERM"] as const) {
  test(`embedded cleanup preserves default ${signal} termination`, () => stopEmbeddedHost({ signal }));
}
for (const host of ["before", "after"] as const) {
  test(`embedded cleanup defers to a host handler registered ${host}`, () => stopEmbeddedHost({ signal: "SIGTERM", host }));
}
for (const capture of ["before", "after"] as const) {
  test(`embedded cleanup cooperates with a capture reaper registered ${capture}`, () => stopEmbeddedHost({ signal: "SIGTERM", capture }));
  test(`host shutdown owns clipboard and capture registered ${capture}`, () => stopEmbeddedHost({ signal: "SIGTERM", capture, host: "after" }));
}
test("signal cleanup waits for publication, refuses later enables, and handles repeated signals", () => stopEmbeddedHost({ signal: "SIGTERM", update: "finishes", repeat: true }));
test("a host registered during cleanup receives the original signal once", () => stopEmbeddedHost({ signal: "SIGTERM", update: "finishes", host: "during" }));
test("a stalled publication cannot suppress default signal termination", () => stopEmbeddedHost({ signal: "SIGTERM", update: "stalls", capture: "before" }), 15_000);
test("shutdown kills a stalled disarm command before restoring signal termination", () => stopEmbeddedHost({ signal: "SIGTERM", slowDisarm: true }), 15_000);
test("shutdown kills a stalled publication before restoring signal termination", () => stopEmbeddedHost({ signal: "SIGTERM", update: "slow-native" }), 15_000);
test("host-owned exit kills its stalled disarm command", () => stopEmbeddedHost({ signal: "SIGTERM", host: "before", releaseOnSignal: true, slowDisarm: true }));
