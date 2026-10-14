import { useSyncExternalStore } from "react";

import type { CaptureField } from "../../capture/fields";

/**
 * The fields last picked for each simulator, or last applied live, used by the next enable. Kept at
 * module scope for the page's life: the Tools panel unmounts its content when it closes, and the
 * device view unmounts while a switch to another simulator loads.
 */
const choices = new Map<string, CaptureField[]>();
const listeners = new Set<() => void>();

function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

/** An empty list is a real pick (metadata only), not a reset to the server's default. */
export function chooseCaptureFields(udid: string, fields: CaptureField[]): void {
  choices.set(udid, [...fields]);
  for (const listener of listeners) listener();
}

export function chosenCaptureFields(udid: string): CaptureField[] | null {
  return choices.get(udid) ?? null;
}

/** The pick for `udid`, or null when none was made and the server's default applies. */
export function useChosenCaptureFields(udid: string): CaptureField[] | null {
  return useSyncExternalStore(
    subscribe,
    () => chosenCaptureFields(udid),
    () => null,
  );
}
