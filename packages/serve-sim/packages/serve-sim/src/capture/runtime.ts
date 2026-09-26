import { locateProxyDylib, trustCaInSimulator } from "./device";
import { configureCapability } from "../launch-manager";
import type { CapabilityDefinition, PreparedCapability } from "../capabilities";
import {
  CAPTURE_SCHEMA_VERSION,
  CaptureStore,
  type CaptureEvent,
  type CaptureMeta,
} from "./store";
import { startMitmProxy, type CaptureProxy, type MitmProxyDeps } from "./mitm-engine";
import { DEFAULT_CAPTURE_FIELDS, type CaptureField } from "./fields";

export class CaptureEnableError extends Error {
  readonly meta: CaptureMeta;

  constructor(meta: CaptureMeta) {
    super(meta.attachError ?? "Network capture could not start");
    this.name = "CaptureEnableError";
    this.meta = meta;
  }
}

interface CaptureSession {
  store: CaptureStore;
  meta: CaptureMeta;
  proxy: CaptureProxy | null;
  cleanup?: Promise<void>;
}

interface EnableRequest {
  cancelled: boolean;
  failed: boolean;
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
}

function notEnabledMeta(udid: string): CaptureMeta {
  return {
    schemaVersion: CAPTURE_SCHEMA_VERSION,
    udid,
    proxyAddress: null,
    attachment: "not-enabled",
    attachError: null,
    droppedOversizedBodies: 0,
  };
}

export type CaptureRuntime = ReturnType<typeof createCaptureRuntime>;

function cancelledMeta(udid: string): CaptureMeta {
  return {
    ...notEnabledMeta(udid),
    attachment: "failed",
    attachError: "Capture was turned off while it was waiting to start. Enable it again to retry.",
  };
}

function assertRequested(udid: string, request: EnableRequest): void {
  if (request.cancelled) throw new CaptureEnableError(cancelledMeta(udid));
}

export function createCaptureRuntime(options: CaptureRuntimeOptions = {}) {
  let policy: readonly CaptureField[] = options.fields ?? DEFAULT_CAPTURE_FIELDS;
  const startProxy =
    options.startProxy ?? ((store: CaptureStore, deps: MitmProxyDeps) => startMitmProxy(store, deps));
  const trustCa = options.trustCa ?? trustCaInSimulator;
  const configure = options.configure ?? configureCapability;
  const locateDylib = options.dylib ?? locateProxyDylib;
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
    byUdid.get(udid)?.meta ?? failedStarts.get(udid) ?? notEnabledMeta(udid);

  const closeSession = async (udid: string, session: CaptureSession): Promise<void> => {
    session.cleanup ??= (async () => {
      await session.proxy?.close();
      session.proxy = null;
      session.meta.proxyAddress = null;
    })().catch((error: unknown) => {
      session.cleanup = undefined;
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
    const store = new CaptureStore();
    const meta: CaptureMeta = {
      schemaVersion: CAPTURE_SCHEMA_VERSION, udid, proxyAddress: null,
      attachment: "starting", attachError: null, droppedOversizedBodies: 0,
    };
    const session: CaptureSession = { store, meta, proxy: null };
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
        fields: policy,
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
      if (!byUdid.has(udid)) notify(udid, { type: "meta", meta: notEnabledMeta(udid) });
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
        promise: Promise.resolve(notEnabledMeta(udid)),
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
          const meta = session?.meta ?? cancelledMeta(udid);
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

    storeFor(udid: string): CaptureStore | null {
      return byUdid.get(udid)?.store ?? null;
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

export const captureRuntime = createCaptureRuntime();
