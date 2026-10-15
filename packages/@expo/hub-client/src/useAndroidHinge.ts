import { useCallback, useEffect, useMemo, useRef, useState } from 'react';

import {
  type AcknowledgedControlReply,
  createAcknowledgedControlQueue,
} from './acknowledged-control-queue';
import {
  ANDROID_HINGE_CONTROLS,
  type AndroidFold,
  type AndroidHingeBackend,
  androidHingeAngleFor,
  androidHingePose,
  canDriveAndroidHinge,
  sameAndroidFold,
} from './android-hinge';
import { INITIAL_DUO_HINGE_COMMANDS } from './duo/duo-hinge-commands';
import { type DuoView } from './duo/duo-view';
import { type HingeControlCommand } from './hinge-control';
import { type DeviceHinge } from './types';

// The emulator's own controls or another viewer can move the hinge. Polling also
// continues without a hinge: a URL without a device follows serve-emu's default
// device, which can change.
const HINGE_POLL_MS = 5000;
// No 3D model presents an Android emulator, so its view is never read.
const ANDROID_HINGE_VIEW: DuoView = { rotation: [0, 0, 0, 1] };
const noop = () => {};

type HingeRequest = { angle: number };

/** Keep the current state when a read describes the same hinge, so it does not re-render. */
function replaceFold(next: AndroidFold) {
  return (previous: AndroidFold | null) => (sameAndroidFold(previous, next) ? previous : next);
}

/**
 * An Android emulator's hinge as a `DeviceHinge`, so the Hub's fold controls
 * work as they do for the iPhone Duo. Commands go through the same
 * acknowledged queue: a live slider coalesces into its newest angle, a preset
 * replaces queued edits, and serve-emu's response is the acknowledgement.
 * Null until serve-emu reports a hinge that Fold settings can drive.
 */
export function useAndroidHinge(backend: AndroidHingeBackend | null): DeviceHinge | null {
  const [fold, setFold] = useState<AndroidFold | null>(null);
  // The requested angle, shown until the queue settles.
  const [previewAngle, setPreviewAngle] = useState<number | null>(null);
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const backendRef = useRef(backend);
  backendRef.current = backend;
  const generationRef = useRef(0);
  const pendingRef = useRef(false);
  // Settled commands; a read that overlaps one may describe the hinge before it.
  const settledRef = useRef(0);
  // Reads the hinge again at once, while a backend is polled.
  const refreshRef = useRef<(() => void) | null>(null);
  const queueRef = useRef<ReturnType<
    typeof createAcknowledgedControlQueue<HingeRequest>
  > | null>(null);

  if (!queueRef.current) {
    queueRef.current = createAcknowledgedControlQueue<HingeRequest>({
      send: ({ requestId, command }) => {
        const target = backendRef.current;
        if (!target) return false;
        const generation = generationRef.current;
        const settle = (reply: AcknowledgedControlReply, next?: AndroidFold) => {
          if (generationRef.current !== generation) return;
          settledRef.current++;
          // After a timeout the queue no longer waits for this reply. It may describe
          // the hinge before or after a newer change, so read the hinge instead.
          if (!queueRef.current?.receive(reply)) refreshRef.current?.();
          else if (next) setFold(replaceFold(next));
        };
        target.setAngle(command.angle).then(
          (next) => settle({ requestId, ok: true }, next),
          (reason: unknown) => {
            const message = reason instanceof Error ? reason.message : '';
            settle({ requestId, ok: false, error: message || undefined });
          },
        );
        return true;
      },
      onPendingChange: (value) => {
        pendingRef.current = value;
        setPending(value);
        if (!value) setPreviewAngle(null);
      },
      onError: (message) => {
        setError(message);
        setPreviewAngle(null);
      },
    });
  }

  useEffect(() => {
    // Late results from the previous device no longer match.
    const generation = ++generationRef.current;
    const queue = queueRef.current;
    setFold(null);
    setPreviewAngle(null);
    setError(null);
    if (!backend) return;

    let cancelled = false;
    let reading = false;
    // A refresh asked for during a read runs after it, as that read may predate the change.
    let readAgain = false;
    let controller: AbortController | null = null;
    const poll = async () => {
      if (cancelled || reading || pendingRef.current) return;
      reading = true;
      controller = new AbortController();
      const settled = settledRef.current;
      try {
        const next = await backend.read(controller.signal);
        if (
          next &&
          !cancelled &&
          generationRef.current === generation &&
          settledRef.current === settled &&
          !pendingRef.current
        ) {
          setFold(replaceFold(next));
        }
      } finally {
        reading = false;
        if (readAgain && !cancelled) {
          readAgain = false;
          void poll();
        }
      }
    };
    refreshRef.current = () => {
      if (reading) readAgain = true;
      else void poll();
    };

    void poll();
    const timer = setInterval(() => void poll(), HINGE_POLL_MS);
    return () => {
      cancelled = true;
      refreshRef.current = null;
      clearInterval(timer);
      controller?.abort();
      // Queued commands belong to the previous device.
      queue?.clear();
    };
  }, [backend]);

  const setControl = useCallback((command: HingeControlCommand) => {
    const target = androidHingeAngleFor(command);
    if ('error' in target) {
      setError(target.error);
      return;
    }
    setError(null);
    setPreviewAngle(target.angle);
    queueRef.current?.enqueue(
      { angle: target.angle },
      { key: command.control, replaceQueued: command.control === 'pose' },
    );
  }, []);

  return useMemo<DeviceHinge | null>(() => {
    if (!fold || !canDriveAndroidHinge(fold)) return null;
    const angle = previewAngle ?? fold.hingeAngle ?? undefined;
    return {
      controls: ANDROID_HINGE_CONTROLS,
      supported: true,
      angle,
      pose: androidHingePose(angle),
      tableMode: false,
      tableModeAvailable: false,
      faceDown: false,
      activeScreenId: fold.posture === 'closed' ? 1 : 3,
      pending,
      error,
      commands: INITIAL_DUO_HINGE_COMMANDS,
      view: ANDROID_HINGE_VIEW,
      modelActive: false,
      modelUrl: null,
      panels: null,
      setControl,
      sendModelTouch: noop,
      sendModelMultiTouch: noop,
      sendModelScroll: noop,
    };
  }, [fold, previewAngle, pending, error, setControl]);
}
