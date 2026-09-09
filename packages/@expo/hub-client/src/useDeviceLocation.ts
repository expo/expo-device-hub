import { useCallback, useEffect, useRef, useState } from "react";

import { type DeviceGeoFix, type DeviceLocationCapabilities } from "./types";

/** What a backend reports about its simulated-location support and its remembered fix. */
export interface DeviceLocationRead {
  supported: boolean;
  location: DeviceGeoFix | null;
}

export interface DeviceLocationBackend {
  /** Backend memory of the last fix. Absent when the backend keeps none (serve-sim). */
  read?: () => Promise<DeviceLocationRead>;
  /** Apply a fix; resolves what was applied. A rejection's message becomes `locationError`. */
  set: (fix: DeviceGeoFix) => Promise<DeviceGeoFix>;
  clear?: () => Promise<void>;
}

interface LocationState extends DeviceLocationRead {
  pending: boolean;
  error: string | null;
}

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
export function useDeviceLocation(backend: DeviceLocationBackend | null) {
  const [state, setState] = useState<LocationState>(NO_LOCATION);
  const generationRef = useRef(0);
  const pendingRef = useRef(false);

  useEffect(() => {
    const generation = ++generationRef.current;
    pendingRef.current = false;
    if (!backend) {
      setState(NO_LOCATION);
      return;
    }
    const read = backend.read;
    if (!read) {
      setState({ ...NO_LOCATION, supported: true });
      return;
    }
    setState(NO_LOCATION);
    void read()
      .then((result) => {
        if (generationRef.current === generation) setState({ ...NO_LOCATION, ...result });
      })
      .catch(() => {});
  }, [backend]);

  const write = useCallback((run: () => Promise<DeviceGeoFix | null>) => {
    if (pendingRef.current) return;
    const generation = generationRef.current;
    pendingRef.current = true;
    setState((current) => ({ ...current, pending: true, error: null }));
    run().then(
      (location) => {
        if (generationRef.current !== generation) return;
        pendingRef.current = false;
        setState((current) => ({ ...current, location, pending: false }));
      },
      (reason: unknown) => {
        if (generationRef.current !== generation) return;
        pendingRef.current = false;
        setState((current) => ({ ...current, pending: false, error: writeFailureMessage(reason) }));
      },
    );
  }, []);

  const setLocation = useCallback(
    (fix: DeviceGeoFix) => {
      if (!backend) return;
      write(() => backend.set(fix));
    },
    [backend, write],
  );

  const clearLocation = useCallback(() => {
    const clear = backend?.clear;
    if (!clear) return;
    write(() => clear().then(() => null));
  }, [backend, write]);

  const locationCapabilities: DeviceLocationCapabilities = state.supported
    ? backend?.clear
      ? { clear: true }
      : {}
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
