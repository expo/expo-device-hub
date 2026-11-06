import { useCallback, useEffect, useMemo, useRef, useState } from "react";

import {
  androidFoldCapabilities,
  androidFoldPose,
  sameAndroidFold,
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
  choice?: number;
  pending: boolean;
  error: string | null;
}
interface Write {
  owner: Owner;
  angle: number;
}

/** Android's fold adapter. Requests from a retired device or token cannot update this one. */
// @ref LLP 0016#android-emulators — share fold state and capabilities without platform UI or placeholder groups
export function useAndroidFold(
  url: string | null,
  fetchImpl: FoldFetch,
  locked: boolean,
  /** Changes when the stream switches displays, for example from the inner display to the cover. */
  streamShape: string | null = null,
) {
  const owner = useMemo<Owner | null>(
    () => (url ? { url, fetchImpl, revision: 0, pending: false, status: null } : null),
    [url, fetchImpl],
  );
  const current = useRef<Owner | null>(null);
  const lockedRef = useRef(locked);
  lockedRef.current = locked;
  const [state, setState] = useState<State | null>(null);
  const [writers] = useState(() => new Map<string, ReturnType<typeof createWriter>>());
  const readNow = useRef<() => void>(() => {});

  function createWriter() {
    return createLatestWriter(
      async ({ owner: target, angle }: Write) => {
        if (current.current !== target) return null;
        if (lockedRef.current)
          throw new Error("Fold changes are unavailable while recording is locked.");
        return requestAndroidFold(target.fetchImpl, target.url, angle);
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
    let readAgain = false;
    const refresh = async () => {
      if (owner.pending) return;
      if (reading) {
        readAgain = true;
        return;
      }
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
        setState((previous) =>
          previous?.owner === owner && sameAndroidFold(previous.status, status)
            ? previous
            : { owner, status, pending: false, error: previous?.error ?? null },
        );
      } catch {
        // Best-effort discovery: an older server or transient read failure offers no new controls.
      } finally {
        reading = false;
        if (readAgain && !controller.signal.aborted) {
          readAgain = false;
          void refresh();
        }
      }
    };
    void refresh();
    readNow.current = () => void refresh();
    const timer = setInterval(() => void refresh(), 5_000);
    return () => {
      readNow.current = () => {};
      current.current = null;
      clearInterval(timer);
      controller.abort();
    };
  }, [owner]);

  // A fold made elsewhere, by another viewer or the emulator's own controls,
  // switches the streamed display at once, while the poll can take 5 s to
  // report the new angle. Read the hinge when the stream changes shape, so a
  // 3D model folds with the display it shows.
  const firstShape = useRef(true);
  useEffect(() => {
    if (firstShape.current) {
      firstShape.current = false;
      return;
    }
    readNow.current();
  }, [streamShape]);

  const visible = state?.owner === owner ? state : null;
  const capabilities: DeviceFoldCapabilities = androidFoldCapabilities(visible?.status ?? null);
  const setControl = useCallback(
    (command: FoldControlCommand) => {
      if (!owner || current.current !== owner || !writer) return;
      const offered = androidFoldCapabilities(owner.status);
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
      if (!offered || command.control === "tableMode") return;
      const angle =
        command.control === "angle" ? command.value : offered.poses[command.value]!.angle;
      owner.pending = true;
      owner.revision++;
      setState({ owner, status: owner.status, choice: angle, pending: true, error: null });
      writer({ owner, angle });
    },
    [owner, writer],
  );

  const status = visible?.status;
  const fold = useMemo<DeviceFold | null>(
    () =>
      status?.supported
        ? {
            angle: visible?.choice ?? status.hingeAngle ?? undefined,
            pose: androidFoldPose(visible?.choice ?? status.hingeAngle ?? undefined),
            pending: visible?.pending ?? false,
            error: visible?.error ?? null,
            setControl,
          }
        : null,
    [status, visible, setControl],
  );
  return { fold, foldCapabilities: capabilities };
}
