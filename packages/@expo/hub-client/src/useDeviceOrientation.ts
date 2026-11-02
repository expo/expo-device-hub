import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";

import { createLatestWriter } from "./latest-writer";
import { nextOrientation, READBACK_GRACE_MS } from "./orientation";
import { type DeviceOrientation, type DeviceOrientationCapabilities } from "./types";

export interface DeviceOrientationBackend {
  /**
   * The device this backend turns. A new backend for the same device, for example after a
   * token change, keeps that device's requests in order; another device does not wait.
   */
  device: string;
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

interface Request {
  backend: DeviceOrientationBackend;
  orientation: DeviceOrientation;
}

/** One request at a time for one device; only the current backend's answers are shown. */
function createOrientationWriter(
  currentRef: { readonly current: DeviceOrientationBackend | null },
  setState: (state: OrientationState) => void,
) {
  return createLatestWriter(
    async ({ backend, orientation }: Request) => {
      // A choice queued for a retired backend must not reach the device.
      if (backend !== currentRef.current) return null;
      return backend.set(orientation);
    },
    (outcome) => {
      if (outcome.value.backend !== currentRef.current) return;
      if (outcome.ok) {
        const orientation = outcome.result ?? outcome.value.orientation;
        setState({ choice: { orientation, answeredAt: performance.now() }, error: null });
      } else {
        setState({ choice: null, error: failureMessage(outcome.error) });
      }
    },
  );
}

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
  // One writer per device for the hook's life, so another device never waits behind a stalled
  // request, and a device that is selected again keeps its earlier request in order.
  const [writers] = useState(() => new Map<string, ReturnType<typeof createOrientationWriter>>());
  const device = backend?.device;
  let writer = device === undefined ? undefined : writers.get(device);
  if (device !== undefined && !writer) {
    writer = createOrientationWriter(currentRef, setState);
    writers.set(device, writer);
  }

  useEffect(() => {
    currentRef.current = backend;
    setState(NO_ORIENTATION);
    return () => {
      currentRef.current = null;
    };
  }, [backend]);

  // The shown pose, updated at once by each choice, so two Rotate calls before a render step
  // through two poses.
  const orientation = state.choice?.orientation ?? reported;
  const shownRef = useRef(orientation);
  useLayoutEffect(() => {
    shownRef.current = orientation;
  }, [orientation]);

  const setOrientation = useCallback(
    (next: DeviceOrientation) => {
      if (!backend || !writer || !backend.orientations.includes(next)) return;
      shownRef.current = next;
      setState({ choice: { orientation: next, answeredAt: null }, error: null });
      writer({ backend, orientation: next });
    },
    [backend, writer],
  );

  /** Choose the pose after the shown one, or after `fallback` when no pose is known. */
  const rotate = useCallback(
    (fallback: DeviceOrientation) => {
      if (!backend) return;
      setOrientation(nextOrientation(shownRef.current ?? fallback, backend.orientations));
    },
    [backend, setOrientation],
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
    orientation,
    orientationPending: state.choice?.answeredAt === null,
    orientationError: state.error,
    orientationCapabilities,
    setOrientation,
    rotate,
    acceptReport,
  };
}
