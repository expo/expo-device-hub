import { Minimize2 } from "lucide-react";
import {
  PRESENTATION_EXIT_BUTTON_SIZE,
  PRESENTATION_EXIT_MARGIN,
  PRESENTATION_EXIT_WRAPPER_PADDING,
} from "../utils/presentation";

export function PresentationExitButton({
  onClick,
  offset,
}: {
  onClick: () => void;
  offset?: { top: number; right: number };
}) {
  return (
    <div
      className="fixed z-50 flex items-center"
      // Sized from the constants presentationExitOffset() measures against.
      style={{
        top: offset?.top ?? PRESENTATION_EXIT_MARGIN,
        right: offset?.right ?? PRESENTATION_EXIT_MARGIN,
        padding: PRESENTATION_EXIT_WRAPPER_PADDING,
      }}
    >
      <button
        type="button"
        onClick={onClick}
        className="flex items-center justify-center bg-transparent border-none rounded-md text-[#8e8e93] cursor-pointer [transition:background_0.15s_ease,color_0.15s_ease] hover:bg-white/8 hover:text-white"
        style={{ width: PRESENTATION_EXIT_BUTTON_SIZE, height: PRESENTATION_EXIT_BUTTON_SIZE }}
        aria-label="Exit full screen"
        title="Exit full screen (Esc)"
      >
        <Minimize2 size={18} strokeWidth={1.75} />
      </button>
    </div>
  );
}
