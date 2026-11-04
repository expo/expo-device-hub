import { useCallback, useEffect, useMemo, useRef, useState } from "react";

import {
  ANDROID_FOLD_CAPABILITIES,
  requestAndroidFold,
  type AndroidFoldStatus,
  type FoldFetch,
} from "./android-fold";
import { foldCommandOffered, type FoldControlCommand } from "./fold";
import { createLatestWriter } from "./latest-writer";
import { type DeviceFold, type DeviceFoldCapabilities } from "./types";

interface Owner {
  url: string;
  fetchImpl: FoldFetch;
  revision: number;
  pending: boolean;
  status: AndroidFoldStatus | null;
}
interface State {
  owner: Owner;
  status: AndroidFoldStatus | null;
  choice?: "closed" | "open";
  pending: boolean;
  error: string | null;
}
interface Write {
  owner: Owner;
  pose: "closed" | "open";
}

/** Android's posture-only adapter. Requests from a retired device or token cannot update this one. */
// @ref LLP 0016#android-emulators — share fold state and capabilities without platform UI or placeholder groups
export function useAndroidFold(url: string | null, fetchImpl: FoldFetch, locked: boolean) {
  const owner = useMemo<Owner | null>(
    () => (url ? { url, fetchImpl, revision: 0, pending: false, status: null } : null),
    [url, fetchImpl],
  );
  const current = useRef<Owner | null>(null);
  const lockedRef = useRef(locked);
  lockedRef.current = locked;
  const [state, setState] = useState<State | null>(null);
  const [writers] = useState(() => new Map<string, ReturnType<typeof createWriter>>());

  function createWriter() {
    return createLatestWriter(
      async ({ owner: target, pose }: Write) => {
        if (current.current !== target) return null;
        if (lockedRef.current)
          throw new Error("Fold changes are unavailable while recording is locked.");
        return requestAndroidFold(
          target.fetchImpl,
          target.url,
          pose === "open" ? "opened" : "closed",
        );
      },
      (outcome) => {
        const target = outcome.value.owner;
        target.pending = false;
        target.revision++;
        if (current.current !== target) return;
        if (outcome.ok && outcome.result) target.status = outcome.result;
        setState({
          owner: target,
          status: target.status,
          pending: false,
          error: outcome.ok
            ? null
            : outcome.error instanceof Error
              ? outcome.error.message
              : "Fold change failed",
        });
      },
    );
  }
  let writer = url ? writers.get(url) : undefined;
  if (url && !writer) {
    writer = createWriter();
    writers.set(url, writer);
  }

  useEffect(() => {
    current.current = owner;
    setState(null);
    if (!owner) return;
    const controller = new AbortController();
    let reading = false;
    const refresh = async () => {
      if (reading || owner.pending) return;
      reading = true;
      const revision = owner.revision;
      try {
        const status = await requestAndroidFold(
          owner.fetchImpl,
          owner.url,
          undefined,
          controller.signal,
        );
        if (current.current !== owner || owner.revision !== revision || owner.pending) return;
        owner.status = status;
        setState((previous) => ({ owner, status, pending: false, error: previous?.error ?? null }));
      } catch {
        // Best-effort discovery: an older server or transient read failure offers no new controls.
      } finally {
        reading = false;
      }
    };
    void refresh();
    const timer = setInterval(() => void refresh(), 5_000);
    return () => {
      current.current = null;
      clearInterval(timer);
      controller.abort();
    };
  }, [owner]);

  const visible = state?.owner === owner ? state : null;
  const capabilities: DeviceFoldCapabilities = visible?.status?.supported
    ? ANDROID_FOLD_CAPABILITIES
    : false;
  const setControl = useCallback(
    (command: FoldControlCommand) => {
      if (!owner || current.current !== owner || !writer) return;
      const offered = owner.status?.supported ? ANDROID_FOLD_CAPABILITIES : false;
      if (!foldCommandOffered(offered, command) || lockedRef.current) {
        setState((previous) => ({
          owner,
          status: owner.status,
          pending: owner.pending,
          choice: previous?.owner === owner ? previous.choice : undefined,
          error: lockedRef.current
            ? "Fold changes are unavailable while recording is locked."
            : "Fold control is not supported.",
        }));
        return;
      }
      if (command.control !== "pose" || (command.value !== "closed" && command.value !== "open"))
        return;
      owner.pending = true;
      owner.revision++;
      setState({ owner, status: owner.status, choice: command.value, pending: true, error: null });
      writer({ owner, pose: command.value });
    },
    [owner, writer],
  );

  const status = visible?.status;
  const fold = useMemo<DeviceFold | null>(
    () =>
      status?.supported
        ? {
            angle: visible?.choice
              ? visible.choice === "closed"
                ? 0
                : 180
              : (status.hingeAngle ?? undefined),
            // Other postures stay custom: half_opened alone cannot tell laptop from book.
            pose:
              visible?.choice ??
              (status.posture === "closed"
                ? "closed"
                : status.posture === "opened"
                  ? "open"
                  : null),
            pending: visible?.pending ?? false,
            error: visible?.error ?? null,
            setControl,
          }
        : null,
    [status, visible, setControl],
  );
  return { fold, foldCapabilities: capabilities };
}
