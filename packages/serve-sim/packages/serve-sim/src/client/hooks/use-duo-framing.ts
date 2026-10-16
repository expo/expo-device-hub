import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { hingeControlState, isHingePreviewObserved, type HingeControlCommand, type HingeControlState, type HingePhysicalOrientation, type HingePose } from "../../hinge-control";
import type { SimulatorOrientation, StreamConfig } from "../types";
import { duoPhysicalPoseChanged } from "../simulator/duo-pose";
import { DUO_FACE_DOWN_HELD, duoFaceDownFraming, duoInitialView, duoObservedView, duoPresetView, duoRotateView, type DuoFaceDownFraming, type DuoView } from "../simulator/duo-view";
import { rotationDegreesForOrientation } from "../simulator/orientation";
import { recordDuoHingeCommand, type DuoHingeCommands } from "../simulator/duo-hinge-commands";
import { createAcknowledgedControlQueue, type AcknowledgedControlReply, type AcknowledgedControlRequest } from "../utils/acknowledged-control-queue";

// @ref LLP 0004#live-pose-observation — local intent, native readback and failed controls share one framing owner
export function useDuoFraming(
  deviceKey: string,
  streamConfig: StreamConfig | null,
  activeStreamConfig: StreamConfig,
  send: (request: AcknowledgedControlRequest<HingeControlCommand>) => boolean,
) {
  const hingeAngle = streamConfig?.hingeAngle;
  const [hingePending, setHingePending] = useState(false);
  const [hingeError, setHingeError] = useState<string | null>(null);
  const [hingePreview, setHingePreview] = useState<HingeControlState | null>(null);
  const [physicalPose, setPhysicalPose] = useState<HingePose | null | undefined>(undefined);
  const [duoView, setDuoView] = useState<DuoView | null>(null);
  const duoViewLocalIntentRef = useRef(false);
  const faceDownFramingRef = useRef<DuoFaceDownFraming>({ saved: null, held: false });
  const observedPoseRef = useRef<{ pose?: HingePose | null; orientation?: HingePhysicalOrientation }>({});
  const hingeRollbackRef = useRef<{
    view: DuoView; localIntent: boolean; faceDown: DuoFaceDownFraming;
    pose: HingePose | null | undefined; orientation: HingePhysicalOrientation | undefined;
  } | null>(null);
  const duoRotationRef = useRef({ turns: 0, revision: 0 });
  const hingePresetRotationsRef = useRef(new WeakMap<HingeControlCommand, { turns: number; revision: number }>());
  const hingePendingRef = useRef(false);
  const [hingeCommands, setHingeCommands] = useState<DuoHingeCommands>({ pending: false, coverDepartures: 0, innerDepartures: 0 });
  const sentHingePoseRef = useRef<HingePose | null | undefined>(undefined);
  const hingeQueueRef = useRef<ReturnType<typeof createAcknowledgedControlQueue<HingeControlCommand>> | null>(null);
  const previewHingeAngle = hingePreview?.hingeAngle ?? hingeAngle;
  const previewHingePose = hingePreview ? hingePreview.hingePose : streamConfig?.hingePose;
  // A pending angle or preset releases Table Mode, so the preview wins over a
  // face-down orientation that another client confirmed.
  const previewFaceDown = (hingePreview?.tableMode ?? activeStreamConfig.tableMode) === true &&
    activeStreamConfig.physicalOrientation === "facedown";
  // Local controls own the hinge until native observation reaches their preview.
  const hingeOwned = hingePending || hingePreview !== null;
  const initialDuoView = useMemo(() => duoInitialView(hingeAngle, streamConfig?.hingePose, activeStreamConfig),
    [hingeAngle, streamConfig?.hingePose, activeStreamConfig]);
  // Control callbacks read the latest native state without re-registering
  // keyboard and folding-handle listeners on every config broadcast.
  const duoControlStateRef = useRef({ streamConfig, initialDuoView, duoView, physicalPose, orientation: activeStreamConfig.orientation, send });
  duoControlStateRef.current = { streamConfig, initialDuoView, duoView, physicalPose, orientation: activeStreamConfig.orientation, send };
  const resetDuoView = useCallback(() => {
    setDuoView(null);
    duoViewLocalIntentRef.current = false;
    faceDownFramingRef.current = { saved: null, held: false };
  }, []);
  const recoverDuoView = useCallback(() => {
    const previous = hingeRollbackRef.current;
    hingeRollbackRef.current = null;
    const orientation = duoControlStateRef.current.streamConfig?.physicalOrientation;
    const turned = previous?.pose != null && previous.orientation !== undefined &&
      orientation !== undefined && orientation !== previous.orientation;
    if (!previous || turned) { resetDuoView(); return; }
    const pose = previous.pose === null && !previous.localIntent ? undefined : previous.pose;
    setDuoView(previous.view);
    setPhysicalPose(pose);
    sentHingePoseRef.current = pose;
    duoViewLocalIntentRef.current = previous.localIntent;
    faceDownFramingRef.current = previous.faceDown;
  }, [resetDuoView]);
  if (!hingeQueueRef.current) {
    hingeQueueRef.current = createAcknowledgedControlQueue<HingeControlCommand>({
      send: (request) => {
        if (!duoControlStateRef.current.send(request)) return false;
        if (request.command.control === "pose") sentHingePoseRef.current = request.command.value;
        const pose = sentHingePoseRef.current;
        setHingeCommands((previous) => recordDuoHingeCommand(previous, request.command, pose));
        return true;
      },
      onPendingChange: (pending) => {
        hingePendingRef.current = pending;
        setHingePending(pending);
        setHingeCommands((previous) => ({ ...previous, pending }));
      },
      onResult: (command, reply) => {
        if (!reply.ok || command.control !== "pose") return;
        const rotation = hingePresetRotationsRef.current.get(command);
        hingePresetRotationsRef.current.delete(command);
        if (!rotation) return;
        const rotated = duoRotationRef.current.revision !== rotation.revision;
        hingeRollbackRef.current = {
          view: duoRotateView(duoPresetView(command.value), duoRotationRef.current.turns - rotation.turns),
          pose: rotated ? null : command.value,
          orientation: duoControlStateRef.current.streamConfig?.physicalOrientation,
          localIntent: true, faceDown: DUO_FACE_DOWN_HELD,
        };
      },
      onError: (message) => {
        setHingeError(message);
        setHingePreview(null);
        setPhysicalPose(undefined);
        sentHingePoseRef.current = undefined;
        recoverDuoView();
      },
    });
  }
  const receive = useCallback((reply: AcknowledgedControlReply) => hingeQueueRef.current?.receive(reply), []);
  const clear = useCallback(() => hingeQueueRef.current?.clear(), []);
  useEffect(() => clear, [clear, deviceKey]);
  const disconnect = useCallback(() => {
    setHingePreview(null);
    if (!hingePendingRef.current) return;
    setPhysicalPose(undefined);
    sentHingePoseRef.current = undefined;
    clear();
    recoverDuoView();
    setHingeError("Connection lost while changing the device pose.");
  }, [clear, recoverDuoView]);
  const setHingeControl = useCallback((command: HingeControlCommand) => {
    const { streamConfig, initialDuoView, duoView, physicalPose } = duoControlStateRef.current;
    if (!hingePendingRef.current) {
      hingeRollbackRef.current = {
        view: duoView ?? initialDuoView, pose: physicalPose,
        orientation: streamConfig?.physicalOrientation,
        localIntent: duoViewLocalIntentRef.current, faceDown: faceDownFramingRef.current,
      };
    }
    setHingeError(null);
    faceDownFramingRef.current = DUO_FACE_DOWN_HELD;
    duoViewLocalIntentRef.current = true;
    // Editing the hinge or Table Mode clears the named preset, but preserves
    // the simulator's physical orientation (for example Laptop on a table).
    if (command.control === "pose") {
      hingePresetRotationsRef.current.set(command, duoRotationRef.current);
      setPhysicalPose(command.value);
      setDuoView(duoPresetView(command.value));
    } else {
      // Lock even an early edit before the first complete native config.
      setDuoView((previous) => previous ?? initialDuoView);
    }
    setHingePreview((previous) => ({
      hingeAngle: previous?.hingeAngle ?? streamConfig?.hingeAngle,
      hingePose: previous ? previous.hingePose : streamConfig?.hingePose,
      tableMode: previous?.tableMode ?? streamConfig?.tableMode,
      ...hingeControlState(command),
    }));
    hingeQueueRef.current?.enqueue(command, { key: command.control, replaceQueued: command.control === "pose" });
  }, []);
  const rotateDevice = useCallback((orientation: SimulatorOrientation, direction?: "left" | "right") => {
    const current = duoControlStateRef.current;
    duoViewLocalIntentRef.current = true;
    const turns = direction ? (direction === "left" ? -1 : 1)
      : (rotationDegreesForOrientation(current.orientation) - rotationDegreesForOrientation(orientation)) / 90;
    duoRotationRef.current = { turns: duoRotationRef.current.turns + turns,
      revision: duoRotationRef.current.revision + 1 };
    if (hingePendingRef.current && hingeRollbackRef.current) {
      hingeRollbackRef.current = { ...hingeRollbackRef.current,
        view: duoRotateView(hingeRollbackRef.current.view, turns), pose: null,
        localIntent: true, faceDown: DUO_FACE_DOWN_HELD,
      };
    }
    setDuoView((previous) => duoRotateView(previous ?? current.initialDuoView, turns));
    faceDownFramingRef.current = DUO_FACE_DOWN_HELD;
    setHingePreview(null);
    setPhysicalPose(null);
    sentHingePoseRef.current = null;
  }, []);
  useEffect(() => {
    setHingePending(false);
    setHingeError(null);
    setHingePreview(null);
    setPhysicalPose(undefined);
    resetDuoView();
    hingeRollbackRef.current = null;
    hingePresetRotationsRef.current = new WeakMap();
    duoRotationRef.current = { turns: 0, revision: 0 };
    observedPoseRef.current = {};
    sentHingePoseRef.current = undefined;
  }, [deviceKey, resetDuoView]);

  useEffect(() => {
    // Use native orientation once when connecting, never as a live view control.
    if (!duoView && activeStreamConfig.screenId !== undefined) setDuoView((previous) => previous ?? initialDuoView);
  }, [duoView, activeStreamConfig.screenId, initialDuoView]);

  useEffect(() => {
    if (!hingePreview || hingePending) return;
    const timer = setTimeout(() => setHingePreview((current) => current === hingePreview ? null : current), 500);
    return () => clearTimeout(timer);
  }, [hingePreview, hingePending]);

  useEffect(() => {
    if (hingePreview && !hingePending && streamConfig && isHingePreviewObserved(hingePreview, streamConfig)) setHingePreview(null);
  }, [hingePreview, hingePending, streamConfig]);

  useEffect(() => {
    // Compare against the state at acknowledgement while the preview waits
    // for readback. An unchanged earlier observation cannot undo the preset.
    const previous = observedPoseRef.current;
    const pose = streamConfig?.hingePose;
    const orientation = streamConfig?.physicalOrientation;
    if (hingePending || !hingeOwned) observedPoseRef.current = { pose, orientation };
    if (hingeOwned) return;
    if (duoPhysicalPoseChanged(physicalPose, previous.orientation, orientation)) {
      setPhysicalPose(pose ?? null);
      sentHingePoseRef.current = pose ?? null;
      setDuoView(pose ? duoPresetView(pose) : null);
      if (pose) faceDownFramingRef.current = { saved: null, held: pose === "tent" };
      duoViewLocalIntentRef.current = false;
    } else if (pose) {
      if (pose !== previous.pose || physicalPose === undefined) {
        if (faceDownFramingRef.current.saved) {
          faceDownFramingRef.current = { saved: null, held: pose === "tent" };
          duoViewLocalIntentRef.current = false;
        }
        setPhysicalPose(pose);
        sentHingePoseRef.current = pose;
        setDuoView((current) => duoObservedView(current, pose, duoViewLocalIntentRef.current));
      }
    }
  }, [hingeOwned, hingePending, streamConfig?.hingePose, streamConfig?.physicalOrientation, physicalPose]);

  useEffect(() => {
    // Another client can turn a half-open device face down without a preset.
    // Frame the elected cover as Tent does, and restore the previous view when
    // the device turns back. Local hinge and rotation controls own the view.
    if (hingeOwned || streamConfig?.hingePose === "tent") return;
    const orientation = streamConfig?.physicalOrientation;
    const tableMode = streamConfig?.tableMode;
    const knownNotFaceDown = tableMode === false || (orientation !== undefined && orientation !== "facedown");
    if (!knownNotFaceDown && (orientation === undefined || tableMode === undefined)) return;
    const faceDown = orientation === "facedown" && tableMode === true;
    const { state, view } = duoFaceDownFraming(faceDownFramingRef.current, faceDown, duoView ?? initialDuoView);
    faceDownFramingRef.current = state;
    if (view) setDuoView(view);
  }, [hingeOwned, streamConfig?.hingePose, streamConfig?.tableMode, streamConfig?.physicalOrientation, duoView, initialDuoView]);

  return {
    pending: hingePending, error: hingeError, preview: hingePreview,
    angle: previewHingeAngle, pose: previewHingePose, physicalPose,
    faceDown: previewFaceDown, view: duoView ?? initialDuoView, commands: hingeCommands,
    control: setHingeControl, rotate: rotateDevice, receive, disconnect, clear,
  };
}
