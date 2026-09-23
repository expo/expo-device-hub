import { hingeControlState, type HingeControlCommand, type HingePose } from "../../hinge-control";
import { duoIntendedScreen } from "./duo-pose";

/** Actual native submissions, separate from previews which the queue can discard. */
export interface DuoHingeCommands {
  pending: boolean;
  coverDepartures: number;
  innerDepartures: number;
}

export function recordDuoHingeCommand(
  previous: DuoHingeCommands,
  command: HingeControlCommand,
  physicalPose?: HingePose | null,
): DuoHingeCommands {
  if (command.control === "table") return previous;
  // Fractional values in the native hysteresis band keep whichever panel is
  // already active; they cannot establish a departure from either panel.
  if (command.control === "angle" && command.value > 54 && command.value < 55) return previous;
  const { hingeAngle } = hingeControlState(command);
  const panel = duoIntendedScreen(hingeAngle, command.control === "pose" ? command.value : physicalPose);
  return {
    ...previous,
    coverDepartures: previous.coverDepartures + (panel === 3 ? 1 : 0),
    innerDepartures: previous.innerDepartures + (panel === 1 ? 1 : 0),
  };
}
