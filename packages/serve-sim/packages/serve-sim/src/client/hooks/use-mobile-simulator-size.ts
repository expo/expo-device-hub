import { useLayoutEffect, useState, type RefObject } from "react";
import { getPresentationFrameWidth } from "../utils/simulator-resize";

// @ref LLP 0000#mobile-serve-sim-layout — fit mobile display space instead of the saved desktop size.
export function useMobileSimulatorSize(
  pageRef: RefObject<HTMLElement | null>,
  actionsRef: RefObject<HTMLElement | null>,
  enabled: boolean,
  aspectRatio: number,
) {
  const [width, setWidth] = useState<number | null>(null);
  useLayoutEffect(() => {
    const page = pageRef.current;
    const actions = actionsRef.current;
    if (!enabled || !page || !actions) {
      setWidth(null);
      return;
    }
    const measure = () => {
      const style = getComputedStyle(page);
      const availableWidth =
        page.clientWidth - parseFloat(style.paddingLeft) - parseFloat(style.paddingRight);
      const actionsHeight = actions.getBoundingClientRect().height;
      const availableHeight =
        page.clientHeight -
        parseFloat(style.paddingTop) -
        parseFloat(style.paddingBottom) -
        (actionsHeight > 0 ? actionsHeight + 12 : 0);
      setWidth(
        availableHeight <= 0
          ? 0
          : getPresentationFrameWidth(availableWidth, availableHeight, aspectRatio),
      );
    };
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(page);
    observer.observe(actions);
    return () => observer.disconnect();
  }, [pageRef, actionsRef, enabled, aspectRatio]);
  return width;
}
