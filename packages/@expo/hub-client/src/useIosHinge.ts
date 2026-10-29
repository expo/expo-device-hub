import { useCallback, useEffect, useMemo, useRef, useState } from "react";

import {
  type HingeControlCommand,
  isHingeControlCommand,
  parseHingeControlReply,
} from "./hinge-control";
import { WS_MSG_HINGE_CONTROL, WS_MSG_HINGE_CONTROL_DONE } from "./input-protocol";
import { screenHingeState } from "./screen-config";
import { type DeviceHinge, type ScreenSize } from "./types";

export const HINGE_INVALID_COMMAND_MESSAGE =
  "The hinge command is not valid. Use an angle from 0 to 180 degrees or one of HINGE_POSES.";
export const HINGE_NOT_CONNECTED_MESSAGE =
  "Could not send the hinge command because simulator input is not connected. Try again when the stream is live.";
export const HINGE_DISCONNECTED_MESSAGE =
  "The simulator connection closed before the hinge command was confirmed. Check the device and send it again.";
const HINGE_FAILED_MESSAGE = "The simulator could not change the hinge. Try the command again.";

const decoder = new TextDecoder();

interface IosHingeOptions {
  screen: ScreenSize | null;
  /** Changes when the device, server or token changes; resets the command state. */
  identity: string | null;
  /** Send once on the admitted input socket. Never queued, because a reply is awaited. */
  trySend: (tag: number, payload: object) => boolean;
}

// @ref LLP 0013#hinge — a command that has no reply fails on disconnect and is never replayed
/** iPhone Duo hinge state from the screen config, and hinge commands over the input socket. */
export function useIosHinge({ screen, identity, trySend }: IosHingeOptions) {
  const requestIdRef = useRef(0);
  const requestsRef = useRef(new Set<number>());
  // Only the newest command's failure is shown, as an older reply can arrive later.
  const latestRequestRef = useRef(0);
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    requestsRef.current.clear();
    setPending(false);
    setError(null);
  }, [identity]);

  const setControl = useCallback(
    (command: HingeControlCommand) => {
      if (!isHingeControlCommand(command)) {
        setError(HINGE_INVALID_COMMAND_MESSAGE);
        return;
      }
      const requestId = ++requestIdRef.current;
      if (!trySend(WS_MSG_HINGE_CONTROL, { requestId, command })) {
        setError(HINGE_NOT_CONNECTED_MESSAGE);
        return;
      }
      requestsRef.current.add(requestId);
      latestRequestRef.current = requestId;
      setError(null);
      setPending(true);
    },
    [trySend],
  );

  /** Handle a `0x90` reply. Returns false for every other frame. */
  const receive = useCallback((bytes: Uint8Array) => {
    if (bytes[0] !== WS_MSG_HINGE_CONTROL_DONE) return false;
    const reply = parseHingeControlReply(decoder.decode(bytes.subarray(1)));
    // A reply to a request that this hook no longer tracks, after a reset or a disconnect, is ignored.
    if (!reply || !requestsRef.current.delete(reply.requestId)) return true;
    if (!reply.ok && reply.requestId === latestRequestRef.current) {
      setError(reply.error ?? HINGE_FAILED_MESSAGE);
    }
    setPending(requestsRef.current.size > 0);
    return true;
  }, []);

  /** The input socket closed: commands without a reply may or may not have moved the hinge. */
  const failPending = useCallback(() => {
    if (requestsRef.current.size === 0) return;
    requestsRef.current.clear();
    setPending(false);
    setError(HINGE_DISCONNECTED_MESSAGE);
  }, []);

  const hinge = useMemo<DeviceHinge | null>(
    () =>
      screen?.supportsHingeAngle === true
        ? {
            ...screenHingeState(screen),
            activeScreenId:
              screen.screenId === 1 || screen.screenId === 3 ? screen.screenId : undefined,
            supportsPhysicalOrientation: screen.supportsPhysicalOrientation,
            pending,
            error,
            setControl,
          }
        : null,
    [screen, pending, error, setControl],
  );

  return { hinge, receive, failPending };
}
