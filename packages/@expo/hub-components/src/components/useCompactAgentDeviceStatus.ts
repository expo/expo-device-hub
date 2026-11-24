import { type RefObject, useLayoutEffect, useState } from "react";

const DEVICE_ROW_GAP = 16;
/** The gap between the items before the version: the marks, the name, and the status. */
const DEVICE_NAME_STATUS_GAP = 4;
const AGENT_STATUS_GAP = 5;

type CompactStatusWidths = {
  available: number;
  /** Width of the marks before the name, with the gap after each one. */
  leading?: number;
  name: number;
  version: number;
  badge: number;
  label: number;
};

export function shouldCompactAgentDeviceStatus(widths: CompactStatusWidths): boolean {
  return (
    (widths.leading ?? 0) +
      widths.name +
      DEVICE_NAME_STATUS_GAP +
      widths.badge +
      AGENT_STATUS_GAP +
      widths.label +
      DEVICE_ROW_GAP +
      widths.version >
    widths.available
  );
}

export function useCompactAgentDeviceStatus({
  buttonRef,
  nameRef,
  statusLabelRef,
  versionRef,
}: {
  buttonRef: RefObject<HTMLButtonElement | null>;
  nameRef: RefObject<HTMLSpanElement | null>;
  statusLabelRef: RefObject<HTMLSpanElement | null>;
  versionRef: RefObject<HTMLSpanElement | null>;
}): boolean {
  const [compact, setCompact] = useState(false);

  useLayoutEffect(() => {
    const button = buttonRef.current;
    const name = nameRef.current;
    const statusLabel = statusLabelRef.current;
    const version = versionRef.current;
    const badge = button?.querySelector<HTMLElement>("[data-agent-device-badge]");
    if (!button || !name || !statusLabel || !version || !badge) return;

    const measure = () => {
      const style = window.getComputedStyle(button);
      const available =
        button.clientWidth - parseFloat(style.paddingLeft) - parseFloat(style.paddingRight);
      let leading = 0;
      for (const mark of button.querySelectorAll<HTMLElement>("[data-device-leading]")) {
        leading += mark.offsetWidth + DEVICE_NAME_STATUS_GAP;
      }
      setCompact(
        shouldCompactAgentDeviceStatus({
          available,
          leading,
          name: name.scrollWidth,
          version: version.scrollWidth,
          badge: badge.offsetWidth,
          label: statusLabel.scrollWidth,
        }),
      );
    };

    let disposed = false;
    const measureIfMounted = () => {
      if (!disposed) measure();
    };

    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(button);
    void document.fonts?.ready.then(measureIfMounted);
    return () => {
      disposed = true;
      observer.disconnect();
    };
  }, [buttonRef, nameRef, statusLabelRef, versionRef]);

  return compact;
}
