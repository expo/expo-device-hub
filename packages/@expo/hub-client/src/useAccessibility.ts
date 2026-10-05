import type { FeatureRead } from './feature-state';
import type { BackendDeviceClient } from './backend-client';
import { useCallback, useEffect, useRef, useState } from 'react';

import { type AccessibilityLoader } from './accessibility';
import { type AccessibilitySnapshot } from './types';

type AccessibilityClientState = Pick<
  BackendDeviceClient,
  'accessibility' | 'accessibilityPending' | 'accessibilityError' | 'refreshAccessibility'
>;

/** Well above the measured reads, 3.6 s on Android and 1.3 s on iOS. */
export const ACCESSIBILITY_READ_TIMEOUT_MS = 10_000;

export function useAccessibility(
  load: AccessibilityLoader | null,
  timeoutMs: number = ACCESSIBILITY_READ_TIMEOUT_MS,
  readState?: FeatureRead,
): AccessibilityClientState {
  const [accessibility, setAccessibility] = useState<AccessibilitySnapshot | null>(null);
  const [accessibilityPending, setAccessibilityPending] = useState(false);
  const [accessibilityError, setAccessibilityError] = useState<string | null>(null);
  const controllerRef = useRef<AbortController | null>(null);

  const refreshAccessibility = useCallback(() => {
    controllerRef.current?.abort();
    controllerRef.current = null;
    if (!load) return;

    const controller = new AbortController();
    controllerRef.current = controller;
    readState?.begin();
    setAccessibilityPending(true);
    setAccessibilityError(null);
    // Neither backend bounds the read: serve-emu retries its dump three times at 8 s each and
    // serve-sim's stream has no server timeout, so an unreachable device would hold the section
    // pending with Refresh disabled.
    const deadline = AbortSignal.timeout(timeoutMs);
    load(AbortSignal.any([controller.signal, deadline]))
      .then((read) => {
        if (controller.signal.aborted) return;
        if (read.ok) {
          setAccessibility(read.snapshot);
          readState?.ready();
        } else {
          setAccessibilityError(read.error);
          readState?.fail(read.error);
        }
      })
      .catch((cause: unknown) => {
        if (controller.signal.aborted) return;
        readState?.fail(deadline.aborted ? new Error('Read timed out') : cause);
        if (deadline.aborted) {
          setAccessibilityError('The device did not answer in time');
          return;
        }
        const message = cause instanceof Error ? cause.message : '';
        setAccessibilityError(message || 'Accessibility read failed');
      })
      .finally(() => {
        if (controllerRef.current === controller) setAccessibilityPending(false);
      });
  }, [load, timeoutMs, readState]);

  useEffect(() => {
    readState?.idle();
    return readState?.bind(refreshAccessibility);
  }, [readState, refreshAccessibility]);

  // Reset in the cleanup, not the body: on a loader change React runs this child's
  // refresh-on-open effect first, and clearing after it would abort that read.
  useEffect(() => {
    return () => {
      controllerRef.current?.abort();
      controllerRef.current = null;
      setAccessibility(null);
      setAccessibilityPending(false);
      setAccessibilityError(null);
    };
  }, [load]);

  return { accessibility, accessibilityPending, accessibilityError, refreshAccessibility };
}
