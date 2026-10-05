import type { FeatureRead } from "./feature-state";
import { useCallback, useEffect, useRef, useState } from "react";

import { type DeviceGeoFix, type DeviceLocationCapabilities } from "./types";

/** What a backend reports about its simulated-location support and its remembered fix. */
export interface DeviceLocationRead {
  supported: boolean;
  location: DeviceGeoFix | null;
}

export interface DeviceLocationBackend {
  /**
   * Backend memory of the last fix. Absent when the backend keeps none (serve-sim).
   * Resolves null when the read could not be answered, which is retried until it is,
   * because a device the Hub just booted answers only once its backend is up.
   */
  read?: (signal: AbortSignal) => Promise<DeviceLocationRead | null>;
  /** Apply a fix; resolves what was applied. A rejection's message becomes `locationError`. */
  set: (fix: DeviceGeoFix) => Promise<DeviceGeoFix>;
  clear?: () => Promise<void>;
}

interface LocationState extends DeviceLocationRead {
  pending: boolean;
  error: string | null;
}

const READ_RETRY_MS = 3000;
const SET_LOCATION_CAPABILITIES: DeviceLocationCapabilities = {};
const CLEAR_LOCATION_CAPABILITIES: DeviceLocationCapabilities = { clear: true };

const NO_LOCATION: LocationState = {
  supported: false,
  location: null,
  pending: false,
  error: null,
};

function writeFailureMessage(reason: unknown): string {
  const message = reason instanceof Error ? reason.message : "";
  return message || "Location update failed";
}

/** One simulated-location fix per device, held for whichever backend the caller supplies. */
export function useDeviceLocation(backend: DeviceLocationBackend | null, readState?: FeatureRead) {
  const [state, setState] = useState<LocationState>(NO_LOCATION);
  const generationRef = useRef(0);
  const pendingRef = useRef(false);

  useEffect(() => {
    const generation = ++generationRef.current;
    pendingRef.current = false;
    setState(NO_LOCATION);
    const read = backend?.read;
    if (!read) {
      if (backend) readState?.ready();
      return;
    }
    readState?.reset();

    let cancelled = false;
    let reading = false;
    let controller: AbortController | null = null;

    const attempt = async () => {
      if (cancelled || reading || readState?.isStopped()) return;
      reading = true;
      controller = new AbortController();
      try {
        const result = await read(controller.signal);
        if (cancelled || generationRef.current !== generation) return;
        if (!result) throw new Error("Location read failed");
        clearInterval(retry);
        setState((current) => ({ ...current, ...result }));
        if (result.supported) readState?.ready();
        else readState?.unsupported();
      } catch (cause) {
        if (!cancelled) readState?.fail(cause, true);
      } finally {
        reading = false;
      }
    };

    const unbind = readState?.bind(() => {
      void attempt();
    });
    void attempt();
    const retry = setInterval(() => void attempt(), READ_RETRY_MS);

    return () => {
      unbind?.();
      cancelled = true;
      clearInterval(retry);
      controller?.abort();
    };
  }, [backend, readState]);

  const write = useCallback((run: () => Promise<DeviceGeoFix | null>) => {
    if (pendingRef.current) return;
    const generation = generationRef.current;
    pendingRef.current = true;
    setState((current) => ({ ...current, pending: true, error: null }));
    return run().then(
      (location) => {
        if (generationRef.current !== generation) return;
        pendingRef.current = false;
        setState((current) => ({ ...current, location, pending: false }));
      },
      (reason: unknown) => {
        if (generationRef.current !== generation) return;
        pendingRef.current = false;
        setState((current) => ({ ...current, pending: false, error: writeFailureMessage(reason) }));
        throw reason;
      },
    );
  }, []);

  const setLocation = useCallback(
    (fix: DeviceGeoFix) => {
      if (!backend) return;
      return write(() => backend.set(fix));
    },
    [backend, write],
  );

  const clearLocation = useCallback(() => {
    const clear = backend?.clear;
    if (!clear) return;
    return write(() => clear().then(() => null));
  }, [backend, write]);

  const supported = backend ? (backend.read ? state.supported : true) : false;
  const locationCapabilities: DeviceLocationCapabilities = supported
    ? backend?.clear
      ? CLEAR_LOCATION_CAPABILITIES
      : SET_LOCATION_CAPABILITIES
    : false;

  return {
    location: state.location,
    locationPending: state.pending,
    locationError: state.error,
    setLocation,
    clearLocation,
    locationCapabilities,
  };
}
