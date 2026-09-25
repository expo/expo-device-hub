import { isDeviceNotBooted } from "../device";
import { locateProxyDylib, trustCaInSimulator, isDeviceInjected } from "./device";
import { configureCapability } from "../launch-manager";
import type { CapabilityDefinition, PreparedCapability } from "../capabilities";
import { CaptureDiskAccumulator, captureArtifactPaths, sweepAbandonedCaptureDirs } from "./disk";
import {
  DEFAULT_CAPTURE_FIELDS,
  type CaptureField,
} from "./fields";
import {
  CAPTURE_SCHEMA_VERSION,
  CaptureStore,
  type CaptureEvent,
  type CaptureMeta,
} from "./store";
import { startMitmProxy, type CaptureProxy, type MitmProxyDeps } from "./mitm-engine";
import { serveSimVersion } from "./version";

export class CaptureEnableError extends Error {
  readonly meta: CaptureMeta;

  constructor(meta: CaptureMeta) {
    super(meta.attachError ?? "Network capture could not start");
    this.name = "CaptureEnableError";
    this.meta = meta;
  }
}

const CHECK_INTERVAL_MS = 10_000;
const INJECT_MISS_THRESHOLD = 2;

interface CaptureSession {
  store: CaptureStore;
  meta: CaptureMeta;
  proxy: CaptureProxy | null;
  cleanup?: Promise<void>;
  disk: CaptureDiskAccumulator | null;
  stopDisk: (() => Promise<void>) | null;
  checking?: Promise<CaptureMeta>;
  checkedAt?: number;
  injectMisses?: number;
}

interface EnableRequest {
  cancelled: boolean;
  failed: boolean;
  fields: readonly CaptureField[];
  promise: Promise<CaptureMeta>;
}

class DeviceOperationQueue {
  readonly #operations = new Map<string, Promise<void>>();

  enqueue<T>(udid: string, operation: () => Promise<T>): Promise<T> {
    const previous = this.#operations.get(udid);
    const result = previous ? previous.then(operation) : operation();
    const settled = result.then(
      () => {},
      () => {},
    );
    this.#operations.set(udid, settled);
    void settled.then(() => {
      if (this.#operations.get(udid) === settled) this.#operations.delete(udid);
    });
    return result;
  }

  devices(): IterableIterator<string> {
    return this.#operations.keys();
  }
}

export interface CaptureRuntimeOptions {
  fields?: readonly CaptureField[];
  startProxy?: (store: CaptureStore, deps: MitmProxyDeps) => Promise<CaptureProxy>;
  trustCa?: (udid: string, caPem: string) => Promise<void>;
  configure?: typeof configureCapability;
  dylib?: () => string | null;
  isInjected?: (udid: string, portFile: string, proxyAddress: string) => Promise<boolean>;
  checkIntervalMs?: number;
  creatorVersion?: string;
  /** How often to stream-rebuild capture.har from the NDJSON entry log (tests). */
  flushIntervalMs?: number;
  writeDiskArtifacts?: boolean;
  captureDirFor?: (udid: string) => string;
}

function notEnabledMeta(udid: string, fields: readonly CaptureField[]): CaptureMeta {
  return {
    schemaVersion: CAPTURE_SCHEMA_VERSION,
    udid,
    proxyAddress: null,
    attachment: "not-enabled",
    attachError: null,
    droppedOversizedBodies: 0,
    fields: [...fields],
  };
}

export type CaptureRuntime = ReturnType<typeof createCaptureRuntime>;

function cancelledMeta(udid: string, fields: readonly CaptureField[]): CaptureMeta {
  return {
    ...notEnabledMeta(udid, fields),
    attachment: "failed",
    attachError: "Capture was turned off while it was waiting to start. Enable it again to retry.",
  };
}

function assertRequested(udid: string, request: EnableRequest): void {
  if (request.cancelled) throw new CaptureEnableError(cancelledMeta(udid, request.fields));
}

export function createCaptureRuntime(options: CaptureRuntimeOptions = {}) {
  let policy: readonly CaptureField[] = options.fields ?? DEFAULT_CAPTURE_FIELDS;
  const startProxy =
    options.startProxy ?? ((store: CaptureStore, deps: MitmProxyDeps) => startMitmProxy(store, deps));
  const trustCa = options.trustCa ?? trustCaInSimulator;
  const configure = options.configure ?? configureCapability;
  const locateDylib = options.dylib ?? locateProxyDylib;
  const isInjected = options.isInjected ?? ((udid: string, portFile: string, proxyAddress: string) =>
    isDeviceInjected(udid, portFile, { expectedPort: Number(new URL(`http://${proxyAddress}`).port) }));
  const checkIntervalMs = options.checkIntervalMs ?? CHECK_INTERVAL_MS;
  const writeDiskArtifacts = options.writeDiskArtifacts !== false;
  const creatorVersion = options.creatorVersion ?? "0.0.0";

  const byUdid = new Map<string, CaptureSession>();
  const deviceCapture = new Map<string, boolean>();
  const operations = new DeviceOperationQueue();
  const enables = new Map<string, EnableRequest>();
  // Set when this server must not capture at all, such as a public preview without a token gate.
  let refusal: string | null = null;
  // Viewers belong to the device, not to one session, so a stream opened before capture starts, or
  // kept open across a restart, follows each new session.
  const viewers = new Map<string, Set<(event: CaptureEvent) => void>>();
  // A start that failed before it had a session still has to read as failed.
  const failedStarts = new Map<string, CaptureMeta>();
  const notify = (udid: string, event: CaptureEvent): void => {
    for (const viewer of viewers.get(udid) ?? []) {
      try {
        viewer(event);
      } catch {}
    }
  };
  const metaOf = (udid: string): CaptureMeta =>
    byUdid.get(udid)?.meta ?? failedStarts.get(udid) ?? notEnabledMeta(udid, policy);

  const attachDisk = (udid: string, store: CaptureStore): Pick<CaptureSession, "disk" | "stopDisk"> => {
    if (!writeDiskArtifacts) return { disk: null, stopDisk: null };
    // Sweep abandoned recordings while preserving live owners.
    if (!options.captureDirFor) sweepAbandonedCaptureDirs([...byUdid.keys(), udid]);
    const paths = options.captureDirFor
      ? {
          dir: options.captureDirFor(udid),
          networkCapturePath: undefined,
          harPath: undefined,
        }
      : captureArtifactPaths(udid);
    const disk = new CaptureDiskAccumulator({
      dir: paths.dir,
      networkCapturePath: paths.networkCapturePath,
      harPath: paths.harPath,
      creatorVersion,
      flushIntervalMs: options.flushIntervalMs,
    });
    return { disk, stopDisk: disk.attach(store) };
  };

  const closeSession = async (udid: string, session: CaptureSession): Promise<void> => {
    session.cleanup ??= (async () => {
      await session.proxy?.close();
      session.proxy = null;
      session.meta.proxyAddress = null;
      await session.stopDisk?.();
      session.stopDisk = null;
      session.disk = null;
    })().catch((error: unknown) => {
      session.cleanup = undefined;
      console.warn(`Network capture: cleanup for ${udid} failed:`, error);
      throw error;
    });
    await session.cleanup;
    if (byUdid.get(udid) === session) byUdid.delete(udid);
  };

  const prepareSession = async (udid: string, request?: EnableRequest): Promise<PreparedCapability> => {
    if (request) assertRequested(udid, request);
    const existing = byUdid.get(udid);
    if (existing?.proxy) {
      if (existing.meta.attachment === "failed") {
        throw new Error("The previous capture session failed. Disable capture before retrying so its launch configuration can be removed safely.");
      }
      return { dylib: requireDylib(), env: { SIMNET_PROXY_PORT_FILE: existing.proxy.portFile } };
    }
    const dylib = requireDylib();
    const sessionFields = [...(request?.fields ?? policy)];
    const store = new CaptureStore();
    const meta: CaptureMeta = {
      schemaVersion: CAPTURE_SCHEMA_VERSION, udid, proxyAddress: null,
      attachment: "starting", attachError: null, droppedOversizedBodies: 0, fields: sessionFields,
    };
    const session: CaptureSession = { store, meta, proxy: null, ...attachDisk(udid, store) };
    store.subscribe((event) => {
      if (byUdid.get(udid) === session) notify(udid, event);
    });
    failedStarts.delete(udid);
    byUdid.set(udid, session);
    // Viewers drop the previous session's rows and follow this one.
    notify(udid, { type: "cleared" });
    notify(udid, { type: "meta", meta });
    try {
      const proxy = await startProxy(store, {
        fields: sessionFields,
        onUnexpectedExit: (reason) => {
          if (byUdid.get(udid) !== session) return;
          meta.attachment = "failed";
          meta.attachError = `${reason}\n\nRelaunch apps after restarting capture; their existing sessions may still point at the stopped proxy.`;
          store.publishMeta(meta);
        },
        onOversizedControlBody: () => {
          if (byUdid.get(udid) !== session) return;
          meta.droppedOversizedBodies += 1;
          store.publishMeta(meta);
        },
      });
      session.proxy = proxy;
      meta.proxyAddress = proxy.address;
      if (request) assertRequested(udid, request);
      await trustCa(udid, await proxy.caPem());
      if (request) assertRequested(udid, request);
      if (meta.attachment === "failed") throw new Error(meta.attachError ?? "The capture proxy stopped during startup.");
      return {
        dylib,
        env: { SIMNET_PROXY_PORT_FILE: proxy.portFile },
        committed() {
          if (meta.attachment === "failed") throw new Error(meta.attachError ?? "The capture proxy stopped during startup.");
          meta.attachment = "capturing";
          store.publishMeta(meta);
        },
        failed(error) {
          meta.attachment = "failed";
          meta.attachError = error instanceof Error ? error.message : String(error);
          store.publishMeta(meta);
        },
        async rollback() {
          if (request) request.failed = true;
          await closeSession(udid, session);
          byUdid.set(udid, session);
        },
      };
    } catch (error) {
      if (request) request.failed = true;
      meta.attachment = "failed";
      meta.attachError = error instanceof Error ? error.message : String(error);
      await closeSession(udid, session);
      byUdid.set(udid, session);
      store.publishMeta(meta);
      throw error;
    }
  };

  function requireDylib(): string {
    const dylib = locateDylib();
    if (!dylib) throw new Error("Network capture library is missing. Rebuild serve-sim's native artifacts before enabling capture.");
    return dylib;
  }

  const capability: CapabilityDefinition = {
    name: "networkCapture", exclusive: true, scope: "userApps", loadPhase: "startupAndDeferred", defaultEnabled: false,
    async setEnabled({ udid, enabled }) {
      if (enabled) return prepareSession(udid);
      const session = byUdid.get(udid);
      if (session) await closeSession(udid, session);
      failedStarts.delete(udid);
      if (!byUdid.has(udid)) notify(udid, { type: "meta", meta: notEnabledMeta(udid, policy) });
      return null;
    },
  };

  const disable = (udid: string) => configure(udid, capability, { enabled: false, relaunch: false });
  const disableDevice = (udid: string): Promise<void> => {
    const pending = enables.get(udid);
    if (pending) pending.cancelled = true;
    enables.delete(udid);
    return operations.enqueue(udid, () => disable(udid));
  };

  return {
    capability,

    shouldCaptureDevice(udid: string, defaultEnabled: boolean): boolean {
      return deviceCapture.get(udid) ?? defaultEnabled;
    },

    setDeviceCaptureEnabled(udid: string, enabled: boolean): void {
      deviceCapture.set(udid, enabled);
    },
    creatorVersion,

    /** Snapshot of the allowlisted capture fields for new sessions. */
    getFields(): readonly CaptureField[] {
      return policy;
    },

    /** Set what every device this server enables is allowed to keep. */
    setFields(next: readonly CaptureField[]): void {
      policy = next;
    },

    enableForDevice(udid: string): Promise<CaptureMeta> {
      const pending = enables.get(udid);
      if (pending && !pending.failed) {
        return pending.promise;
      }
      const request: EnableRequest = {
        cancelled: false,
        failed: false,
        fields: [...policy],
        promise: Promise.resolve(notEnabledMeta(udid, policy)),
      };
      const promise = operations.enqueue(udid, async () => {
        assertRequested(udid, request);
        try {
          if (refusal) throw new Error(refusal);
          // Inside the try, so a failed cleanup reports as a CaptureEnableError like any other.
          const existing = byUdid.get(udid);
          if (existing?.meta.attachment === "failed") {
            await disable(udid);
            assertRequested(udid, request);
          }
          await configure(udid, {
            ...capability,
            setEnabled: ({ enabled }) => enabled
              ? prepareSession(udid, request)
              : capability.setEnabled({ udid, enabled: false, bundleId: null, options: {} }),
          }, { enabled: true, relaunch: false });
          if (request.cancelled) {
            await disable(udid);
            assertRequested(udid, request);
          }
          const session = byUdid.get(udid);
          if (!session) throw new Error("The capture session disappeared during startup. Enable capture again.");
          return session.meta;
        } catch (error) {
          request.failed = true;
          const session = byUdid.get(udid);
          const meta = session?.meta ?? cancelledMeta(udid, request.fields);
          meta.attachment = "failed";
          meta.attachError = error instanceof Error ? error.message : String(error);
          if (session) {
            session.store.publishMeta(meta);
          } else {
            failedStarts.set(udid, meta);
            notify(udid, { type: "meta", meta });
          }
          throw new CaptureEnableError(meta);
        }
      });
      request.promise = promise;
      enables.set(udid, request);
      const forget = () => {
        if (enables.get(udid) === request) enables.delete(udid);
      };
      void promise.then(forget, forget);
      return promise;
    },

    disableForDevice: disableDevice,

    /** Refuse every capture start with `reason`, or allow starts again with null. */
    refuseCapture(reason: string | null): void {
      refusal = reason;
    },

    /** Disable every device, waiting for all of them; rejects with every failure once all settle. */
    async disableAll(): Promise<void> {
      const devices = new Set([...byUdid.keys(), ...operations.devices()]);
      const results = await Promise.allSettled([...devices].map(disableDevice));
      const failures = results.flatMap((result) => (result.status === "rejected" ? [result.reason] : []));
      if (failures.length > 0) {
        throw new AggregateError(failures, `Could not disable network capture on ${failures.length} device(s).`);
      }
    },

    /** Remove every session's capture files at once. Only for process exit, where teardown cannot await. */
    discardArtifactsSync(): void {
      for (const session of byUdid.values()) {
        try {
          session.disk?.discardSync();
        } catch {}
      }
    },

    subscribe(udid: string, listener: (event: CaptureEvent) => void): { meta: CaptureMeta; unsubscribe: () => void } {
      let set = viewers.get(udid);
      if (!set) viewers.set(udid, (set = new Set()));
      set.add(listener);
      return {
        meta: metaOf(udid),
        unsubscribe: () => {
          set.delete(listener);
          if (set.size === 0 && viewers.get(udid) === set) viewers.delete(udid);
        },
      };
    },

    metaFor(udid: string): CaptureMeta {
      return metaOf(udid);
    },

    /** Re-check injection; publish meta only on change. */
    async refreshForDevice(udid: string): Promise<CaptureMeta> {
      const session = byUdid.get(udid);
      if (!session) return notEnabledMeta(udid, policy);
      if (session.meta.attachment !== "capturing" || !session.proxy) return session.meta;

      const now = Date.now();
      if (session.checking) return session.checking;
      if (session.checkedAt !== undefined && now - session.checkedAt < checkIntervalMs) return session.meta;

      const portFile = session.proxy.portFile;
      const proxyAddress = session.proxy.address;
      session.checking = (async () => {
        try {
          let live: boolean;
          try {
            live = await isInjected(udid, portFile, proxyAddress);
          } catch (error) {
            if (!isDeviceNotBooted(error)) {
              console.warn(
                `Network capture: injection probe for ${udid} failed:`,
                error instanceof Error ? error.message : error,
              );
              session.injectMisses = 0;
              return session.meta;
            }
            live = false;
          }
          if (live) {
            session.injectMisses = 0;
            return session.meta;
          }

          session.injectMisses = (session.injectMisses ?? 0) + 1;
          if (session.injectMisses < INJECT_MISS_THRESHOLD) return session.meta;

          session.meta.attachment = "failed";
          session.meta.attachError =
            "This device stopped capturing. It may have restarted or shut down since capture was " +
            "enabled. Enable capture again after it boots.";
          session.store.publishMeta(session.meta);
          return session.meta;
        } finally {
          session.checkedAt = Date.now();
          session.checking = undefined;
        }
      })();
      return session.checking;
    },

    storeFor(udid: string): CaptureStore | null {
      return byUdid.get(udid)?.store ?? null;
    },

    artifactPathsFor(
      udid: string,
    ): { networkCapturePath: string; harPath: string; entriesPath: string } | null {
      const disk = byUdid.get(udid)?.disk;
      if (!disk) return null;
      return {
        networkCapturePath: disk.networkCapturePath,
        harPath: disk.harPath,
        entriesPath: disk.entriesPath,
      };
    },

    /** Flush NDJSON → capture.har and return its path, or null if not capturing to disk. */
    async flushHarPathFor(udid: string): Promise<string | null> {
      const disk = byUdid.get(udid)?.disk;
      if (!disk) return null;
      await disk.flush();
      return disk.harPath;
    },

    clearForDevice(udid: string): boolean {
      const session = byUdid.get(udid);
      if (!session) return false;
      session.store.clear();
      return true;
    },

    throughputFor(udid: string): { netInBytesPerSec: number; netOutBytesPerSec: number } | null {
      const session = byUdid.get(udid);
      if (!session || session.meta.attachment !== "capturing") return null;
      return session.store.throughput();
    },
  };
}

export const captureRuntime = createCaptureRuntime({
  creatorVersion: serveSimVersion(),
});
