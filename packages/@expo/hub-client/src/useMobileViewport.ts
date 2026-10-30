import { useLayoutEffect, useState } from "react";
import { isVisualViewportKeyboardRaised } from "./viewport-keyboard";

export function readMobileViewport() {
  if (typeof window === "undefined")
    return { mobile: false, height: 0, width: 0, top: 0, left: 0, keyboardRaised: false };
  const visual = window.visualViewport;
  const coarse = window.matchMedia?.("(pointer: coarse)").matches === true;
  return {
    mobile:
      window.innerWidth < 640 || (coarse && window.innerWidth < 1024 && window.innerHeight < 500),
    height: visual?.height ?? window.innerHeight,
    width: visual?.width ?? window.innerWidth,
    top: visual?.offsetTop ?? 0,
    left: visual?.offsetLeft ?? 0,
    keyboardRaised:
      coarse &&
      isVisualViewportKeyboardRaised(
        window.innerHeight,
        visual?.height ?? window.innerHeight,
        visual?.scale ?? 1,
      ),
  };
}

// @ref LLP 0000#mobile-hub-layout — share visible viewport bounds between the dashboard and its viewer.
export function useMobileViewport() {
  const [viewport, setViewport] = useState(readMobileViewport);
  useLayoutEffect(() => {
    const update = () => setViewport(readMobileViewport());
    const visual = window.visualViewport;
    update();
    window.addEventListener("resize", update);
    visual?.addEventListener("resize", update);
    visual?.addEventListener("scroll", update);
    return () => {
      window.removeEventListener("resize", update);
      visual?.removeEventListener("resize", update);
      visual?.removeEventListener("scroll", update);
    };
  }, []);
  return viewport;
}
