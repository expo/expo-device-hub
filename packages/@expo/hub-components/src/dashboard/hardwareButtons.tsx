import {
  type ComponentType,
  type CSSProperties,
  type KeyboardEvent,
  type PointerEvent,
  useCallback,
  useEffect,
  useRef,
} from "react";
import {
  type DeviceChrome,
  type DevicePlatform,
  type HardwareButton,
  type HardwareButtonPhase,
} from "@expo/hub-client";

import {
  BellOffIcon,
  CircleDotIcon,
  HomeIcon,
  icon as iconColor,
  LockIcon,
  PowerIcon,
  text,
  VolumeDownIcon,
  VolumeUpIcon,
} from "../primitives";
import { type DeviceFrameRect } from "./deviceFrame";

// Hardware button icons beside the device frame, as Apple's Device Hub and serve-sim's preview
// show them: hidden until the pointer is on a button's area, then only that edge's icons fade
// and slide in, with the hovered one accented. Each button's area covers the button and the
// strip outside the frame where its icon sits, and pressing anywhere in it holds the button.

export type FrameEdge = "top" | "right" | "bottom" | "left";

export type FrameButton = {
  /** Stable id within one frame; DeviceKit input names for iOS. */
  key: string;
  button: HardwareButton;
  /** The button's rect in the frame's portrait coordinates. */
  rect: DeviceFrameRect;
  /** The edge its icon sits beyond; the nearest frame edge when absent. */
  edge?: FrameEdge;
};

/** Hover and press state shared by the button areas and the DeviceKit sprites. */
export type FrameButtonActivity = { hovered: string | null; pressed: string | null };

export const NO_FRAME_BUTTON_ACTIVITY: FrameButtonActivity = { hovered: null, pressed: null };

// DeviceKit chrome.json input names that hub-client can press.
const DEVICEKIT_BUTTONS: Record<string, HardwareButton> = {
  power: "power",
  "volume-up": "volumeUp",
  "volume-down": "volumeDown",
  action: "action",
  mute: "ringer",
  home: "home",
};

/** The pressable buttons of a DeviceKit chrome. */
export function deviceKitFrameButtons(chrome: DeviceChrome): FrameButton[] {
  return chrome.buttons.flatMap((button) => {
    const mapped = DEVICEKIT_BUTTONS[button.name];
    return mapped && button.usagePage != null && button.usage != null
      ? [
          {
            key: button.name,
            button: mapped,
            rect: button.frame,
            edge: deviceKitButtonEdge(chrome.body, button.frame),
          },
        ]
      : [];
  });
}

/** serve-sim's rule: the bezel edge a button crosses; a button inside the body is on the bottom. */
function deviceKitButtonEdge(body: DeviceFrameRect, rect: DeviceFrameRect): FrameEdge {
  if (rect.x < body.x) return "left";
  if (rect.x + rect.width > body.x + body.width) return "right";
  if (rect.y < body.y) return "top";
  return "bottom";
}

/** The frame edge nearest a button, which its icon sits beyond. */
export function frameButtonEdge(
  frame: { width: number; height: number },
  rect: DeviceFrameRect,
): FrameEdge {
  const distances: Array<[FrameEdge, number]> = [
    ["left", rect.x],
    ["right", frame.width - rect.x - rect.width],
    ["top", rect.y],
    ["bottom", frame.height - rect.y - rect.height],
  ];
  return distances.reduce((nearest, entry) => (entry[1] < nearest[1] ? entry : nearest))[0];
}

const GLYPH_GAP_PX = 10;
const GLYPH_SIZE_PX = 16;
/** How far an icon reaches past the frame; the panel keeps this much room around it. */
export const FRAME_BUTTON_REACH_PX = GLYPH_GAP_PX + GLYPH_SIZE_PX;
const GLYPH_SLIDE_PX = 6;
const AREA_SLACK_PX = 12;
/** The bezel cap's slide-out timing; the icons fade and slide on the same curve. */
export const FRAME_BUTTON_TRANSITION = "0.12s ease";

const ICONS: Record<HardwareButton, ComponentType<{ size?: number; color?: string }> | null> = {
  power: LockIcon,
  volumeUp: VolumeUpIcon,
  volumeDown: VolumeDownIcon,
  action: CircleDotIcon,
  ringer: BellOffIcon,
  home: HomeIcon,
  back: null,
  recents: null,
  appSwitcher: null,
  hideKeyboard: null,
};

const LABELS: Partial<Record<HardwareButton, string>> = {
  power: "Lock",
  volumeUp: "Volume Up",
  volumeDown: "Volume Down",
  action: "Action",
  ringer: "Ring/Silent",
  home: "Home",
};

function iconFor(button: HardwareButton, platform: DevicePlatform) {
  // Device Hub shows a lock beside an iPhone's side button; Android names it Power.
  if (button === "power" && platform === "android") return { Icon: PowerIcon, label: "Power" };
  const Icon = ICONS[button];
  return Icon ? { Icon, label: LABELS[button] ?? button } : null;
}

function percent(value: number, total: number): string {
  return `${((value / total) * 100).toFixed(4)}%`;
}

/** Browser events after which a held pointer or key can no longer send its release. */
function listenForInputCancellation(cancel: () => void): () => void {
  if (typeof window === "undefined" || typeof document === "undefined") return () => {};
  const onVisibilityChange = () => {
    if (document.hidden) cancel();
  };
  window.addEventListener("blur", cancel);
  window.addEventListener("pagehide", cancel);
  document.addEventListener("visibilitychange", onVisibilityChange);
  return () => {
    window.removeEventListener("blur", cancel);
    window.removeEventListener("pagehide", cancel);
    document.removeEventListener("visibilitychange", onVisibilityChange);
  };
}

/**
 * Button areas and icons for one frame, drawn in its rotated artwork box so they follow the
 * device. The icons turn back upright inside that box.
 */
export function FrameButtonLayer({
  frame,
  buttons,
  platform,
  rotation,
  style,
  activity,
  onActivity,
  owner,
  onPress,
}: {
  frame: { width: number; height: number };
  buttons: ReadonlyArray<FrameButton>;
  platform: DevicePlatform;
  rotation: number;
  style: CSSProperties;
  activity: FrameButtonActivity;
  onActivity: (update: (current: FrameButtonActivity) => FrameButtonActivity) => void;
  /**
   * The selected device's id. A change releases a button held on the previous device. Not the
   * client object, which is new on most renders.
   */
  owner: string;
  onPress: (button: HardwareButton, phase: HardwareButtonPhase) => void;
}) {
  // The held button and the release bound to the client that pressed it, so a device switch,
  // unmount, or lost window focus still sends its up to that client, and only once.
  // `sources` are the pointer and activation keys holding it; the last one to let go releases it.
  const held = useRef<{ key: string; sources: Set<string>; release: () => void } | null>(null);
  const releaseHeld = useCallback(() => {
    const current = held.current;
    held.current = null;
    current?.release();
  }, []);
  useEffect(() => releaseHeld, [owner, releaseHeld]);
  useEffect(() => listenForInputCancellation(releaseHeld), [releaseHeld]);

  const pressable = buttons.filter((entry) => iconFor(entry.button, platform));
  // A removed area can no longer receive its pointer's release, so its hold ends here.
  const pressableKeys = pressable.map((entry) => entry.key).join("\n");
  useEffect(() => {
    const current = held.current;
    if (current && !pressableKeys.split("\n").includes(current.key)) releaseHeld();
  }, [pressableKeys, releaseHeld]);
  if (!pressable.length) return null;
  const activeKey = activity.pressed ?? activity.hovered;
  const activeEntry = pressable.find((entry) => entry.key === activeKey);
  const shownEdge = activeEntry ? edgeOf(frame, activeEntry) : null;

  return (
    <div data-frame-buttons="" style={{ ...style, pointerEvents: "none" }}>
      {pressable.map((entry) => {
        const edge = edgeOf(frame, entry);
        const { Icon, label } = iconFor(entry.button, platform)!;
        const press = (source: string) => {
          if (held.current?.key === entry.key) {
            held.current.sources.add(source);
            return;
          }
          releaseHeld();
          const sendUp = onPress;
          held.current = {
            key: entry.key,
            sources: new Set([source]),
            release: () => {
              onActivity((current) =>
                current.pressed === entry.key ? { ...current, pressed: null } : current,
              );
              sendUp(entry.button, "up");
            },
          };
          onActivity((current) => ({ ...current, pressed: entry.key }));
          onPress(entry.button, "down");
        };
        const release = (source: string) => {
          if (held.current?.key !== entry.key) return;
          held.current.sources.delete(source);
          if (!held.current.sources.size) releaseHeld();
        };
        // A captured pointer's release always reaches this area. A pointer without capture
        // ("free-pointer") may be released elsewhere, so leaving the area ends its hold.
        const releasePointer = (id: number) => {
          release(`pointer:${id}`);
          release(`free-pointer:${id}`);
        };
        // Focus loss ends the keys' and uncaptured pointers' holds, not a captured pointer's.
        const releaseUnreachable = () => {
          if (held.current?.key !== entry.key) return;
          for (const source of held.current.sources) {
            if (!source.startsWith("pointer:")) held.current.sources.delete(source);
          }
          if (!held.current.sources.size) releaseHeld();
        };
        const show = () => onActivity((current) => ({ ...current, hovered: entry.key }));
        const hide = () =>
          onActivity((current) =>
            current.hovered === entry.key ? { ...current, hovered: null } : current,
          );
        const activationKey = (event: KeyboardEvent<HTMLDivElement>) =>
          event.key === "Enter" || event.key === " ";
        return (
          <div key={entry.key}>
            <div
              data-hardware-button={entry.key}
              role="button"
              aria-label={label}
              title={label}
              tabIndex={0}
              style={{
                ...areaStyle(frame, entry, edge, pressable),
                position: "absolute",
              }}
              onPointerEnter={show}
              onPointerLeave={(event: PointerEvent<HTMLDivElement>) => {
                release(`free-pointer:${event.pointerId}`);
                hide();
              }}
              onFocus={show}
              onBlur={() => {
                releaseUnreachable();
                hide();
              }}
              onKeyDown={(event: KeyboardEvent<HTMLDivElement>) => {
                if (!activationKey(event)) return;
                event.preventDefault();
                if (!event.repeat) press(`key:${event.code || event.key}`);
              }}
              onKeyUp={(event: KeyboardEvent<HTMLDivElement>) => {
                if (activationKey(event)) release(`key:${event.code || event.key}`);
              }}
              onPointerDown={(event: PointerEvent<HTMLDivElement>) => {
                if (event.button !== 0 && event.pointerType === "mouse") return;
                event.preventDefault();
                event.stopPropagation();
                let captured = true;
                try {
                  event.currentTarget.setPointerCapture(event.pointerId);
                } catch {
                  captured = false;
                }
                press(`${captured ? "pointer" : "free-pointer"}:${event.pointerId}`);
              }}
              onPointerUp={(event: PointerEvent<HTMLDivElement>) => releasePointer(event.pointerId)}
              onPointerCancel={(event: PointerEvent<HTMLDivElement>) =>
                releasePointer(event.pointerId)
              }
              // After capture is lost, this pointer's up may never reach the area.
              onLostPointerCapture={(event: PointerEvent<HTMLDivElement>) =>
                releasePointer(event.pointerId)
              }
            />
            <ButtonIcon
              id={entry.key}
              Icon={Icon}
              frame={frame}
              rect={entry.rect}
              edge={edge}
              rotation={rotation}
              shown={shownEdge === edge}
              active={entry.key === activeKey}
            />
          </div>
        );
      })}
    </div>
  );
}

function edgeOf(frame: { width: number; height: number }, entry: FrameButton): FrameEdge {
  return entry.edge ?? frameButtonEdge(frame, entry.rect);
}

/**
 * From the button's inner edge out past its icon, slightly longer than the button. Toward a
 * neighbor on the same edge, the slack stops at the midpoint between them, so a rocker's halves
 * do not overlap.
 */
function areaStyle(
  frame: { width: number; height: number },
  entry: FrameButton,
  edge: FrameEdge,
  all: ReadonlyArray<FrameButton>,
): CSSProperties {
  const { rect } = entry;
  const vertical = edge === "left" || edge === "right";
  const total = vertical ? frame.height : frame.width;
  const span = (r: DeviceFrameRect) => (vertical ? [r.y, r.y + r.height] : [r.x, r.x + r.width]);
  const [start, end] = span(rect);
  let before: number | null = null;
  let after: number | null = null;
  for (const other of all) {
    if (other === entry || edgeOf(frame, other) !== edge) continue;
    const [otherStart, otherEnd] = span(other.rect);
    if (otherEnd <= start) before = Math.max(before ?? otherEnd, otherEnd);
    if (otherStart >= end) after = Math.min(after ?? otherStart, otherStart);
  }
  // The inset from one end of the edge, limited by the midpoint toward a neighbor.
  const inset = (offset: number, limit: number | null) => {
    const slack = `calc(${percent(offset, total)} - ${AREA_SLACK_PX}px)`;
    return limit === null ? slack : `max(${slack}, ${percent(limit, total)})`;
  };
  const outward = FRAME_BUTTON_REACH_PX + AREA_SLACK_PX;
  const along: CSSProperties = {
    [vertical ? "top" : "left"]: inset(start, before === null ? null : (before + start) / 2),
    [vertical ? "bottom" : "right"]: inset(
      total - end,
      after === null ? null : total - (end + after) / 2,
    ),
  };
  const across: Record<FrameEdge, CSSProperties> = {
    left: {
      right: percent(frame.width - rect.x - rect.width, frame.width),
      width: `calc(${percent(rect.x + rect.width, frame.width)} + ${outward}px)`,
    },
    right: {
      left: percent(rect.x, frame.width),
      width: `calc(${percent(frame.width - rect.x, frame.width)} + ${outward}px)`,
    },
    top: {
      bottom: percent(frame.height - rect.y - rect.height, frame.height),
      height: `calc(${percent(rect.y + rect.height, frame.height)} + ${outward}px)`,
    },
    bottom: {
      top: percent(rect.y, frame.height),
      height: `calc(${percent(frame.height - rect.y, frame.height)} + ${outward}px)`,
    },
  };
  return {
    ...along,
    ...across[edge],
    cursor: "pointer",
    pointerEvents: "auto",
    touchAction: "none",
  };
}

function ButtonIcon({
  id,
  Icon,
  frame,
  rect,
  edge,
  rotation,
  shown,
  active,
}: {
  id: string;
  Icon: ComponentType<{ size?: number; color?: string }>;
  frame: { width: number; height: number };
  rect: DeviceFrameRect;
  edge: FrameEdge;
  rotation: number;
  shown: boolean;
  active: boolean;
}) {
  const outside = `calc(100% + ${GLYPH_GAP_PX}px)`;
  const alongY = percent(rect.y + rect.height / 2, frame.height);
  const alongX = percent(rect.x + rect.width / 2, frame.width);
  const s = GLYPH_SLIDE_PX;
  // Position, centering shift, and the hidden icon's offset toward the bezel.
  const placements: Record<FrameEdge, [CSSProperties, string, string]> = {
    left: [{ right: outside, top: alongY }, "translateY(-50%)", `translate(${s}px, 0px)`],
    right: [{ left: outside, top: alongY }, "translateY(-50%)", `translate(-${s}px, 0px)`],
    top: [{ bottom: outside, left: alongX }, "translateX(-50%)", `translate(0px, ${s}px)`],
    bottom: [{ top: outside, left: alongX }, "translateX(-50%)", `translate(0px, -${s}px)`],
  };
  const [place, shift, tuck] = placements[edge];
  return (
    <div
      data-hardware-button-icon={id}
      aria-hidden="true"
      style={{
        ...place,
        position: "absolute",
        width: GLYPH_SIZE_PX,
        height: GLYPH_SIZE_PX,
        display: "flex",
        color: active ? text.link : iconColor.secondary,
        opacity: shown ? 1 : 0,
        transform: shown ? shift : `${shift} ${tuck}`,
        transition: `color ${FRAME_BUTTON_TRANSITION}, opacity ${FRAME_BUTTON_TRANSITION}, transform ${FRAME_BUTTON_TRANSITION}`,
        pointerEvents: "none",
      }}
    >
      {/* The slide animates in artwork coordinates; turning upright must not animate. */}
      <div
        style={
          rotation ? { display: "flex", transform: `rotate(${-rotation}deg)` } : { display: "flex" }
        }
      >
        <Icon size={GLYPH_SIZE_PX} />
      </div>
    </div>
  );
}
