import { useCallback, useEffect, useRef, useState } from 'react';

import { type AccessibilityLoader } from './accessibility';
import { type AccessibilitySnapshot, type DeviceClient } from './types';

type AccessibilityClientState = Pick<
  DeviceClient,
  'accessibility' | 'accessibilityPending' | 'accessibilityError' | 'refreshAccessibility'
>;

export function useAccessibility(load: AccessibilityLoader | null): AccessibilityClientState {
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
    setAccessibilityPending(true);
    setAccessibilityError(null);
    load(controller.signal)
      .then((read) => {
        if (controller.signal.aborted) return;
        if (read.ok) setAccessibility(read.snapshot);
        else setAccessibilityError(read.error);
      })
      .catch((cause: unknown) => {
        if (controller.signal.aborted) return;
        const message = cause instanceof Error ? cause.message : '';
        setAccessibilityError(message || 'Accessibility read failed');
      })
      .finally(() => {
        if (controllerRef.current === controller) setAccessibilityPending(false);
      });
  }, [load]);

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
