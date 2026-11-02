import { useCallback, useEffect, useMemo, useRef, useState } from "react";

import { createLatestWriter } from "./latest-writer";
import { READBACK_GRACE_MS } from "./orientation";
import { type DeviceOrientation, type DeviceOrientationCapabilities } from "./types";

export interface DeviceOrientationBackend {
  /** The poses `set` accepts. */
  orientations: readonly DeviceOrientation[];
  /**
   * Turn the device. Resolves the pose the backend applied, or null when it does not say. A
   * rejection's message becomes `orientationError`; the client does not retry it.
   */
  set: (orientation: DeviceOrientation) => Promise<DeviceOrientation | null>;
  /**
   * True when the backend pushes a report only when the pose changes (serve-sim). A choice the
   * device does not take then gives way after the readback grace without a new report.
   */
  pushesReports?: boolean;
}

interface Choice {
  orientation: DeviceOrientation;
  /** When the backend answered; null while the request is in flight. */
  answeredAt: number | null;
}

interface OrientationState {
  choice: Choice | null;
  error: string | null;
}

const NO_ORIENTATION: OrientationState = { choice: null, error: null };

function failureMessage(reason: unknown): string {
  const message = reason instanceof Error ? reason.message : "";
  return message || "Orientation change failed";
}

/**
 * The pose a device is turned to, for whichever backend the caller supplies. A choice shows at
 * once and stays until a report that started after the backend's answer shows that pose, or
 * until the readback grace has passed: the display can turn after the answer, and an app can
 * keep its own orientation. A new backend (device, token or connection) starts over and drops
 * a choice that has not been sent yet.
 */
// @ref LLP 0013#orientation — one request at a time, the newest choice wins, answers wait for a report
export function useDeviceOrientation(
  backend: DeviceOrientationBackend | null,
  reported: DeviceOrientation | null,
) {
  const [state, setState] = useState<OrientationState>(NO_ORIENTATION);
  // The backend in use; null after its device, token or connection is gone, or on unmount.
  const currentRef = useRef<DeviceOrientationBackend | null>(null);
  // One writer per backend, so another device never waits behind a stalled request.
  const writer = useMemo(
    () =>
      backend &&
      createLatestWriter(
        async (orientation: DeviceOrientation) => {
          // A choice queued for a retired backend must not reach the device.
          if (backend !== currentRef.current) return null;
          return backend.set(orientation);
        },
        (outcome) => {
          if (backend !== currentRef.current) return;
          if (outcome.ok) {
            const orientation = outcome.result ?? outcome.value;
            setState({ choice: { orientation, answeredAt: performance.now() }, error: null });
          } else {
            setState({ choice: null, error: failureMessage(outcome.error) });
          }
        },
      ),
    [backend],
  );

  useEffect(() => {
    currentRef.current = backend;
    setState(NO_ORIENTATION);
    return () => {
      currentRef.current = null;
    };
  }, [backend]);

  const setOrientation = useCallback(
    (orientation: DeviceOrientation) => {
      if (!backend || !writer || !backend.orientations.includes(orientation)) return;
      setState({ choice: { orientation, answeredAt: null }, error: null });
      writer(orientation);
    },
    [backend, writer],
  );

  /** Apply one report of the shown pose, read from `startedAt` on (`performance.now()` time). */
  const acceptReport = useCallback((orientation: DeviceOrientation | null, startedAt: number) => {
    setState((current) => {
      const answeredAt = current.choice?.answeredAt;
      if (answeredAt == null || answeredAt > startedAt) return current;
      const confirmed = current.choice?.orientation === orientation;
      if (!confirmed && performance.now() - answeredAt < READBACK_GRACE_MS) return current;
      return { ...current, choice: null };
    });
  }, []);

  // A pushed report does not come again for an unchanged pose, so the grace ends the choice.
  const answeredAt = state.choice?.answeredAt ?? null;
  const pushesReports = backend?.pushesReports === true;
  useEffect(() => {
    if (answeredAt === null || !pushesReports) return;
    const timer = setTimeout(
      () =>
        setState((current) =>
          current.choice?.answeredAt === answeredAt ? { ...current, choice: null } : current,
        ),
      Math.max(0, READBACK_GRACE_MS - (performance.now() - answeredAt)),
    );
    return () => clearTimeout(timer);
  }, [answeredAt, pushesReports]);

  const orientations = backend?.orientations;
  const orientationCapabilities = useMemo<DeviceOrientationCapabilities>(
    () => (orientations ? { orientations } : false),
    [orientations],
  );

  return {
    orientation: state.choice?.orientation ?? reported,
    orientationPending: state.choice?.answeredAt === null,
    orientationError: state.error,
    orientationCapabilities,
    setOrientation,
    acceptReport,
  };
}
