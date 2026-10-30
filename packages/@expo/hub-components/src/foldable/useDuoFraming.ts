/**
 * The iPhone Duo model's framing and panel handoffs, which serve-sim's client
 * keeps beside its hinge state (@expo/serve-sim 0.5.0). Here the model is a
 * consumer of `@expo/hub-client`: it follows the fold state and the client's
 * hinge command events, whichever control sent the command.
 */

import {
  type DeviceHinge,
  type HingeCommandEvent,
  type HingeControlCommand,
  type ScreenSize,
} from "@expo/hub-client";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";

import {
  DUO_FACE_DOWN_HELD,
  type DuoFaceDownFraming,
  type DuoView,
  duoFaceDownFraming,
  duoInitialView,
  duoPresetView,
  duoRotateView,
} from "./duo-view";

/** Commands that the device received, which the scene uses to track panel handoffs. */
export interface DuoHingeCommands {
  pending: boolean;
  /** Commands sent that move the device off the cover. */
  coverDepartures: number;
  /** Commands sent that move the device off the inner display. */
  innerDepartures: number;
}

/** Count a submission by the display it elects; a command that elects none departs from neither. */
export function recordDuoDeparture(
  previous: Omit<DuoHingeCommands, "pending">,
  display: number | undefined,
): Omit<DuoHingeCommands, "pending"> {
  return {
    coverDepartures: previous.coverDepartures + (display === 3 ? 1 : 0),
    innerDepartures: previous.innerDepartures + (display === 1 ? 1 : 0),
  };
}

// @ref LLP 0004#3d-preview-in-the-hub — the model frames itself from fold state and hinge events
export function useDuoFraming(hinge: DeviceHinge | null, screen: ScreenSize | null) {
  const initialView = useMemo(
    () => duoInitialView(screen?.hingeAngle, screen?.hingePose, screen),
    [screen],
  );
  const initialViewRef = useRef(initialView);
  initialViewRef.current = initialView;
  // The ref is the source of truth, so events in one task see each other's views.
  const viewRef = useRef<DuoView | null>(null);
  const [view, setViewState] = useState<DuoView | null>(null);
  const setView = useCallback((next: (previous: DuoView | null) => DuoView | null) => {
    viewRef.current = next(viewRef.current);
    setViewState(viewRef.current);
  }, []);
  const faceDownRef = useRef<DuoFaceDownFraming>({ saved: null, held: false });
  // The last accepted view before pending presets. A failed preset restores
  // it. A Rotate supersedes it, so the next preset records a new one, and only
  // that burst's own accepted presets advance it.
  const restoreRef = useRef<{ view: DuoView | null; presets: WeakSet<HingeControlCommand> } | null>(
    null,
  );
  // Local commands own the framing from their request until the device confirms them.
  const [owned, setOwned] = useState(false);
  const rotatedRef = useRef(false);
  const [departures, setDepartures] = useState({ coverDepartures: 0, innerDepartures: 0 });

  const observe = hinge?.observe;
  useEffect(() => {
    if (!observe) return;
    return observe((event: HingeCommandEvent) => {
      switch (event.type) {
        case "requested": {
          const { command } = event;
          faceDownRef.current = DUO_FACE_DOWN_HELD;
          setOwned(true);
          if (command.control === "pose") {
            // Remember the view before the first preset of a burst; each
            // acknowledgement advances it without changing the optimistic view.
            restoreRef.current ??= { view: viewRef.current, presets: new WeakSet() };
            restoreRef.current.presets.add(command);
            setView(() => duoPresetView(command.value));
          } else {
            // Lock even an early edit before the first complete native config.
            setView((previous) => previous ?? initialViewRef.current);
          }
          return;
        }
        case "sent":
          setDepartures((previous) => recordDuoDeparture(previous, event.display));
          return;
        case "acknowledged": {
          // A preset from before a Rotate leaves the newer view alone.
          const restore = restoreRef.current;
          if (event.ok && event.command.control === "pose" && restore?.presets.has(event.command)) {
            restore.view = duoPresetView(event.command.value);
          }
          return;
        }
        case "confirmed":
          restoreRef.current = null;
          setOwned(false);
          return;
        case "failed": {
          // A failure discards the whole queue, including any preset whose
          // view is already showing but was never sent or confirmed.
          const restore = restoreRef.current;
          restoreRef.current = null;
          if (restore) setView(() => restore.view);
          setOwned(false);
          return;
        }
        case "reset":
          // A new helper session: no view from the old one comes back, and
          // the model is framed as on connect. Departure counts stay monotonic,
          // because the scene compares them only with its own last reading.
          restoreRef.current = null;
          faceDownRef.current = { saved: null, held: false };
          setView(() => null);
          setOwned(false);
          return;
        case "rotated":
          // The view turns at once, without waiting for a frame.
          restoreRef.current = null;
          rotatedRef.current = true;
          faceDownRef.current = DUO_FACE_DOWN_HELD;
          setView((previous) => duoRotateView(previous ?? initialViewRef.current, 1));
          setOwned(false);
          return;
      }
    });
  }, [observe, setView]);

  useEffect(() => {
    // Use native orientation once when connecting, never as a live view control.
    if (!view && screen?.screenId !== undefined) {
      setView((previous) => previous ?? initialView);
    }
  }, [view, screen?.screenId, initialView, setView]);

  // The client forgets the physical pose when the device was turned over
  // elsewhere without a preset, or when it rotated. Only the first is framed
  // as on connect; face-down framing below still turns it to the cover.
  const physicalPose = hinge?.physicalPose;
  const previousPoseRef = useRef(physicalPose);
  useEffect(() => {
    const previous = previousPoseRef.current;
    previousPoseRef.current = physicalPose;
    if (previous && physicalPose === null && !rotatedRef.current) setView(() => null);
  }, [physicalPose, setView]);
  useEffect(() => {
    rotatedRef.current = false;
  });

  const pending = hinge?.pending ?? false;
  useEffect(() => {
    // Another client can turn a half-open device face down without a preset.
    // Frame the elected cover as Tent does, and restore the previous view when
    // the device turns back. Local hinge and rotation controls own the view.
    if (owned || pending || screen?.hingePose === "tent") return;
    const faceDown = screen?.tableMode === true && screen.physicalOrientation === "facedown";
    const { state, view: framed } = duoFaceDownFraming(
      faceDownRef.current,
      faceDown,
      view ?? initialView,
    );
    faceDownRef.current = state;
    if (framed) setView(() => framed);
  }, [
    owned,
    pending,
    screen?.hingePose,
    screen?.tableMode,
    screen?.physicalOrientation,
    view,
    initialView,
    setView,
  ]);

  const commands = useMemo<DuoHingeCommands>(
    () => ({ pending, ...departures }),
    [pending, departures],
  );
  return { view: view ?? initialView, commands };
}
