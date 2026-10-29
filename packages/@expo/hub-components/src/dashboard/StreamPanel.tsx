import { type ComponentType, useEffect, useLayoutEffect, useRef, useState } from "react";

import {
  KeyboardCapture,
  useMobileViewport,
  type AgentInteraction,
  type DeviceClient,
  type DeviceScreenProps,
  type ScreenSize,
} from "@expo/hub-client";
import {
  bg,
  border,
  radius,
  ControlButton,
  FullScreenIcon,
  CloseIcon,
  SidebarIcon,
} from "../primitives";
import { type Device } from "./data";
import { DEVICE_TITLE_HEIGHT, DeviceTitle } from "./DeviceTitle";
import { type ClipboardRequest, ClipboardToaster, useClipboardToast } from "./ClipboardToast";
import { type DeviceFrameAssets } from "./deviceFrame";
import { PhoneFrame } from "./PhoneFrame";
import { ScreenshotToaster, useScreenshotToast } from "./ScreenshotToast";
import { STREAM_CONTROLS_HEIGHT, StreamControls } from "./StreamControls";

/** Space between the title pill and the top of the device frame. */
const TITLE_GAP = 32;
/** Space between the bottom of the device frame and the toolbar. */
const CONTROLS_GAP = 32;

/**
 * Center panel: the selected device's stream and its controls. Rendered as the
 * gray canvas between the white sidebars — `bg.subtle` from edge to edge,
 * separated from each sidebar by the same `border.default` hairline that
 * divides the inspector sections.
 *
 * Desktop anchors the title and toolbar to the frame and reserves their height
 * as padding. Mobile hides the title and uses a normal-flow footer, so fitting
 * and toolbar wrapping happen in one layout without waiting for an observer.
 */
export function StreamPanel({
  device,
  client,
  agentInteraction,
  DeviceScreen,
  displayScreen,
  framed = true,
  showDeviceFrame = true,
  deviceFrameAssets,
  onClipboardFallback,
  onToggleInspector,
  inspectorOpen = false,
}: {
  device: Device;
  client: DeviceClient;
  agentInteraction?: AgentInteraction | null;
  /** Live-stream renderer, injected from `@expo/hub-client` by the consumer. */
  DeviceScreen: ComponentType<DeviceScreenProps>;
  /** Orientation-corrected screen sizer, injected from `@expo/hub-client`. */
  displayScreen: (screen?: ScreenSize | null) => ScreenSize | null;
  /**
   * Whether to draw the hairline seams toward the sidebars. Compact layouts
   * disable this so the center view reaches every viewport edge unbroken.
   */
  framed?: boolean;
  /** Viewer-local preference for displaying supported device artwork. */
  showDeviceFrame?: boolean;
  /** Consumer-owned frame artwork keyed by the selected device's frame kind. */
  deviceFrameAssets?: DeviceFrameAssets;
  /** A toolbar Paste or Copy could not use the browser clipboard. Show the inspector's Clipboard section. */
  onClipboardFallback?: (request: ClipboardRequest) => void;
  /** Put the dashboard inspector toggle in the mobile viewer toolbar. */
  onToggleInspector?: () => void;
  inspectorOpen?: boolean;
}) {
  const viewport = useMobileViewport();
  const [presentation, setPresentation] = useState(false);
  const [keyboardOpen, setKeyboardOpen] = useState(false);
  const keyboardRef = useRef<HTMLInputElement | null>(null);
  const panelRef = useRef<HTMLElement | null>(null);
  const wasTyping = useRef(false);
  const fullScreenRef = useRef<HTMLButtonElement | null>(null);
  const presenting = viewport.mobile && presentation;
  const typing = viewport.mobile && viewport.keyboardRaised;
  useEffect(() => {
    if (wasTyping.current && !typing) {
      keyboardRef.current?.blur();
      setKeyboardOpen(false);
    }
    wasTyping.current = typing;
  }, [typing]);
  useLayoutEffect(() => {
    if (!presenting) return;
    const panel = panelRef.current;
    const parent = panel?.parentElement;
    if (!parent) return;
    const previous = new Map<HTMLElement, boolean>();
    const protectSiblings = () => {
      for (const node of parent.children) {
        if (node === panel || !(node instanceof HTMLElement) || previous.has(node)) continue;
        previous.set(node, node.inert);
        node.inert = true;
      }
    };
    protectSiblings();
    const observer = new MutationObserver(protectSiblings);
    observer.observe(parent, { childList: true });
    return () => {
      observer.disconnect();
      previous.forEach((inert, node) => {
        node.inert = inert;
      });
    };
  }, [presenting]);
  useEffect(() => {
    if (!viewport.mobile) {
      setPresentation(false);
      setKeyboardOpen(false);
    }
  }, [viewport.mobile]);
  useEffect(() => {
    setKeyboardOpen(false);
  }, [device.id]);
  useEffect(() => {
    if (!presenting) return;
    const escape = (event: KeyboardEvent) => {
      if (event.key !== "Escape") return;
      event.preventDefault();
      event.stopPropagation();
      setPresentation(false);
      if (!typing) fullScreenRef.current?.focus();
    };
    window.addEventListener("keydown", escape, true);
    return () => window.removeEventListener("keydown", escape, true);
  }, [presenting, typing]);
  const toggleKeyboard = () => {
    if (
      keyboardOpen &&
      (viewport.keyboardRaised || document.activeElement === keyboardRef.current)
    ) {
      keyboardRef.current?.blur();
      setKeyboardOpen(false);
    } else {
      keyboardRef.current?.focus();
      setKeyboardOpen(true);
    }
  };
  const controlsRef = useRef<HTMLDivElement>(null);
  const [controlsHeight, setControlsHeight] = useState(STREAM_CONTROLS_HEIGHT);
  useLayoutEffect(() => {
    const element = controlsRef.current;
    if (viewport.mobile || !element || typeof ResizeObserver === "undefined") return;
    const measure = () => setControlsHeight(element.getBoundingClientRect().height);
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(element);
    return () => observer.disconnect();
  }, [viewport.mobile]);
  const captureScreenshot = useScreenshotToast(client, device.name);
  const clipboard = useClipboardToast(client, device.id, onClipboardFallback);
  // Command+V in the device screen reports through the clipboard toasts, as in serve-sim.
  const screenClient: DeviceClient = { ...client, pasteText: clipboard.pasteText };

  const controls = (
    <StreamControls
      recording={client.screenRecording}
      onHome={() => client.pressButton("home")}
      onReload={() => client.reload()}
      onRotate={() => client.rotate()}
      onSave={captureScreenshot}
      clipboard={client.capabilities.clipboard}
      clipboardPending={client.clipboardPending}
      onPaste={() => void clipboard.pasteFromDevice()}
      onCopy={() => void clipboard.copyFromSimulator()}
      keyboard={
        viewport.mobile && client.sendKeyEvents
          ? { open: keyboardOpen && typing, onToggle: toggleKeyboard }
          : undefined
      }
      // Full screen and a raised keyboard hide everything but the pill that holds Keyboard.
      compact={viewport.mobile && (presenting || typing)}
    />
  );

  return (
    <section
      ref={panelRef}
      onBlurCapture={(event) => {
        if (!event.currentTarget.contains(event.relatedTarget as Node | null))
          setKeyboardOpen(false);
      }}
      style={{
        flex: 1,
        position: viewport.mobile ? "relative" : undefined,
        minWidth: 0,
        gap: viewport.mobile ? 8 : undefined,
        display: "flex",
        flexDirection: "column",
        padding: viewport.mobile
          ? `calc(${presenting ? 8 : 56}px + env(safe-area-inset-top, 0px)) 8px calc(8px + env(safe-area-inset-bottom, 0px))`
          : 40,
        ...(presenting
          ? ({
              position: "fixed",
              top: viewport.top,
              left: viewport.left,
              width: viewport.width,
              height: viewport.height,
              zIndex: 20,
            } as const)
          : {}),
        boxSizing: "border-box",
        backgroundColor: bg.subtle,
        borderLeft: framed ? `1px solid ${border.default}` : "none",
        borderRight: framed ? `1px solid ${border.default}` : "none",
        overflow: "hidden",
      }}
    >
      {viewport.mobile && (
        <>
          {client.sendKeyEvents && (
            <KeyboardCapture
              open={keyboardOpen}
              inputRef={keyboardRef}
              onKeys={client.sendKeyEvents}
            />
          )}
          <div
            role="group"
            aria-label="Viewer controls"
            onMouseDownCapture={(event) => {
              if (typing || keyboardOpen) event.preventDefault();
            }}
            style={{
              position: "absolute",
              top: `calc(${presenting || typing ? 8 : 72}px + env(safe-area-inset-top, 0px))`,
              maxHeight: `calc(100% - ${presenting || typing ? 16 : 80}px - env(safe-area-inset-top, 0px) - env(safe-area-inset-bottom, 0px))`,
              overflowY: "auto",
              overscrollBehavior: "contain",
              boxSizing: "border-box",
              right: 8,
              zIndex: 3,
              display: "flex",
              flexDirection: "column",
              backgroundColor: bg.element,
              border: `1px solid ${border.default}`,
              borderRadius: radius.xl,
            }}
          >
            <ControlButton
              hideTooltip
              ref={fullScreenRef}
              icon={presenting ? <CloseIcon /> : <FullScreenIcon />}
              label={presenting ? "Exit full screen" : "Full screen"}
              aria-pressed={presenting}
              onClick={() => setPresentation(!presenting)}
            />
            {onToggleInspector && (
              <ControlButton
                hideTooltip
                icon={<SidebarIcon style={{ transform: "scaleX(-1)" }} />}
                label="Toggle inspector"
                aria-pressed={inspectorOpen}
                onClick={() => {
                  // Presentation makes dashboard siblings inert; leave it before opening one.
                  setPresentation(false);
                  onToggleInspector();
                }}
              />
            )}
          </div>
        </>
      )}
      <div
        data-testid="device-frame-viewport"
        style={{
          flex: 1,
          minWidth: 0,
          minHeight: 0,
          width: "100%",
          boxSizing: "border-box",
          // Container-query units resolve against the content box, so this
          // padding keeps the frame clear of the title above and toolbar below.
          padding: viewport.mobile
            ? 0
            : `${DEVICE_TITLE_HEIGHT + TITLE_GAP}px 0 ${controlsHeight + CONTROLS_GAP}px`,
          containerType: "size",
          display: "flex",
          alignItems: "center",
          justifyContent: "center",
        }}
      >
        <div
          data-testid="device-frame-anchor"
          style={{
            position: "relative",
            display: "flex",
            // Safari otherwise retains the stretched height when keyboard fitting narrows the frame.
            alignItems: viewport.mobile ? "center" : undefined,
            flexShrink: 0,
          }}
        >
          <PhoneFrame
            device={device}
            client={screenClient}
            preserveKeyboardFocus={viewport.mobile && keyboardOpen}
            agentInteraction={agentInteraction}
            onCopy={async () => {
              if (!client.clipboardPending) await clipboard.copyFromSimulator();
            }}
            DeviceScreen={DeviceScreen}
            displayScreen={displayScreen}
            showDeviceFrame={showDeviceFrame}
            deviceFrameAssets={deviceFrameAssets}
          />
          {!viewport.mobile && (
            <div
              style={{
                position: "absolute",
                left: "50%",
                bottom: `calc(100% + ${TITLE_GAP}px)`,
                display: "flex",
                justifyContent: "center",
                width: "max-content",
                // Bound by the panel, not the frame: `cqw` resolves against the
                // viewport container, so long names keep the panel's width.
                maxWidth: "100cqw",
                transform: "translateX(-50%)",
              }}
            >
              <DeviceTitle
                key={device.id}
                device={device}
                status={client.status}
                recording={client.screenRecording}
              />
            </div>
          )}
          {!viewport.mobile && (
            <div
              ref={controlsRef}
              style={{
                position: "absolute",
                left: "50%",
                top: `calc(100% + ${CONTROLS_GAP}px)`,
                width: "max-content",
                maxWidth: "100cqw",
                transform: "translateX(-50%)",
              }}
            >
              {controls}
            </div>
          )}
          <ClipboardToaster />
        </div>
      </div>
      {viewport.mobile && (
        <div
          onMouseDownCapture={(event) => {
            if (typing || keyboardOpen) event.preventDefault();
          }}
          style={{
            flexShrink: 0,
            // Without a Keyboard toggle there is nothing to keep in compact mode.
            display: (presenting || typing) && !client.sendKeyEvents ? "none" : "flex",
            justifyContent: "center",
          }}
        >
          {controls}
        </div>
      )}
      <ScreenshotToaster />
    </section>
  );
}
