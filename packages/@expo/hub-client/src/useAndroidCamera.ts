import { type RefObject, useCallback, useEffect, useRef, useState } from "react";

import { deviceApiUrl } from "./android-api-url";
import {
  androidCameraErrorMessage,
  androidCameraImagePath,
  applyCameraRead,
  NO_ANDROID_CAMERA,
  parseAndroidCameraStatus,
} from "./android-camera";
import { NO_PENDING_CAMERA_WRITES } from "./device-camera";
import { KeyedWriteTracker } from "./keyed-write-tracker";
import { type DeviceCameraFacing } from "./types";

const CAMERA_POLL_MS = 3000;

interface UseAndroidCameraOptions {
  active: boolean;
  baseUrl: string | null;
  device: string | null;
  /** Identity of the current connection. A change invalidates in-flight reads and writes. */
  scope: string;
  scopeRef: RefObject<string>;
}

function cameraImageUrl(baseUrl: string, device: string | null) {
  return (facing: DeviceCameraFacing, digest: string | null) =>
    deviceApiUrl(baseUrl, androidCameraImagePath(facing, digest), device);
}

/** Host-fed emulator camera images: polls serve-emu for the feeds and replaces them. */
export function useAndroidCamera({
  active,
  baseUrl,
  device,
  scope,
  scopeRef,
}: UseAndroidCameraOptions) {
  const [camera, setCamera] = useState(NO_ANDROID_CAMERA);
  const [cameraPending, setCameraPending] =
    useState<ReadonlySet<DeviceCameraFacing>>(NO_PENDING_CAMERA_WRITES);
  const [cameraError, setCameraError] = useState<string | null>(null);
  const writeTrackerRef = useRef(new KeyedWriteTracker<DeviceCameraFacing>());

  const writeCameraImage = useCallback(
    (facing: DeviceCameraFacing, init: RequestInit) => {
      if (!baseUrl) return;
      const tracker = writeTrackerRef.current;
      const request = tracker.start(facing);
      if (!request) return;
      const imageUrl = cameraImageUrl(baseUrl, device);
      const statusUrl = deviceApiUrl(baseUrl, "/api/camera", device);

      // A write response is authoritative for its own facing, so nothing is held back.
      const applyStatus = (payload: unknown) => {
        setCamera((current) =>
          applyCameraRead(
            current,
            parseAndroidCameraStatus(payload, imageUrl),
            NO_PENDING_CAMERA_WRITES,
          ),
        );
      };

      setCameraError(null);
      setCameraPending(tracker.pending);

      void fetch(deviceApiUrl(baseUrl, androidCameraImagePath(facing, null), device), init)
        .then(async (response) => {
          const payload: unknown = await response.json().catch(() => null);
          if (!tracker.isCurrent(request) || scopeRef.current !== scope) return;
          if (response.ok) {
            applyStatus(payload);
            return;
          }
          setCameraError(androidCameraErrorMessage(response.status, payload));
          const refreshed: unknown = await fetch(statusUrl, { cache: "no-store" })
            .then((refresh) => (refresh.ok ? refresh.json() : null))
            .catch(() => null);
          if (!tracker.isCurrent(request) || scopeRef.current !== scope) return;
          applyStatus(refreshed);
        })
        .catch(() => {
          if (!tracker.isCurrent(request) || scopeRef.current !== scope) return;
          setCameraError("Camera update failed");
        })
        .finally(() => {
          if (tracker.finish(request)) setCameraPending(tracker.pending);
        });
    },
    [baseUrl, device, scope, scopeRef],
  );

  const setCameraImage = useCallback(
    (facing: DeviceCameraFacing, png: Blob) =>
      writeCameraImage(facing, {
        method: "POST",
        headers: { "Content-Type": "image/png" },
        body: png,
      }),
    [writeCameraImage],
  );

  const clearCameraImage = useCallback(
    (facing: DeviceCameraFacing) => writeCameraImage(facing, { method: "DELETE" }),
    [writeCameraImage],
  );

  useEffect(() => {
    const tracker = writeTrackerRef.current;
    tracker.reset();
    setCameraPending(NO_PENDING_CAMERA_WRITES);
    setCamera(NO_ANDROID_CAMERA);
    setCameraError(null);
    if (!active || !baseUrl) {
      return;
    }

    let cancelled = false;
    let polling = false;
    let controller: AbortController | null = null;
    const imageUrl = cameraImageUrl(baseUrl, device);
    const url = deviceApiUrl(baseUrl, "/api/camera", device);

    const poll = async () => {
      if (cancelled || polling) return;
      polling = true;
      const pendingAtStart = tracker.pending;
      const next = new AbortController();
      controller = next;
      try {
        const response = await fetch(url, { cache: "no-store", signal: next.signal });
        const read = response.ok ? parseAndroidCameraStatus(await response.json(), imageUrl) : null;
        if (cancelled || scopeRef.current !== scope) return;
        const pendingFacings = new Set([...pendingAtStart, ...tracker.pending]);
        setCamera((current) => applyCameraRead(current, read, pendingFacings));
      } catch {
      } finally {
        polling = false;
      }
    };

    void poll();
    const timer = setInterval(() => void poll(), CAMERA_POLL_MS);
    return () => {
      cancelled = true;
      clearInterval(timer);
      controller?.abort();
      tracker.reset();
    };
  }, [active, baseUrl, device, scope, scopeRef]);

  return {
    camera: camera.status,
    cameraSupported: camera.supported,
    cameraPending,
    cameraError,
    setCameraImage,
    clearCameraImage,
  };
}
