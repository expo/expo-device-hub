import { type CSSProperties } from "react";

/**
 * Small line icons used across the dashboard. They draw with `currentColor` by
 * default so they inherit the surrounding text/icon token color. Names mirror
 * the Figma layers (plus, refresh-cw, home, camera, dots-horizontal).
 */
type IconProps = {
  size?: number;
  color?: string;
  strokeWidth?: number;
  style?: CSSProperties;
};

export function PlusIcon({
  size = 18,
  color = "currentColor",
  strokeWidth = 1.5,
  style,
}: IconProps) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" style={style}>
      <path d="M12 5v14M5 12h14" stroke={color} strokeWidth={strokeWidth} strokeLinecap="round" />
    </svg>
  );
}

export function CloseIcon({
  size = 18,
  color = "currentColor",
  strokeWidth = 1.67,
  style,
}: IconProps) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" style={style}>
      <path
        d="M18 6 6 18M6 6l12 12"
        stroke={color}
        strokeWidth={strokeWidth}
        strokeLinecap="round"
      />
    </svg>
  );
}

export function PhoneIcon({
  size = 28,
  color = "currentColor",
  strokeWidth = 1.5,
  style,
}: IconProps) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" style={style}>
      <rect x="6" y="2" width="12" height="20" rx="3" stroke={color} strokeWidth={strokeWidth} />
      <path d="M10 18.5h4" stroke={color} strokeWidth={strokeWidth} strokeLinecap="round" />
    </svg>
  );
}

export function RefreshIcon({
  size = 16,
  color = "currentColor",
  strokeWidth = 1.5,
  style,
}: IconProps) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" style={style}>
      <path
        d="M21 12A9 9 0 1 1 18.36 5.64L20.72 8M17.12 8H20.72V4.4"
        stroke={color}
        strokeWidth={strokeWidth}
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </svg>
  );
}

export function BackIcon({
  size = 18,
  color = "currentColor",
  strokeWidth = 1.67,
  style,
}: IconProps) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" style={style}>
      <path
        d="M19 12H5M12 19l-7-7 7-7"
        stroke={color}
        strokeWidth={strokeWidth}
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </svg>
  );
}

export function RecentsIcon({
  size = 16,
  color = "currentColor",
  strokeWidth = 1.67,
  style,
}: IconProps) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" style={style}>
      <rect x="5" y="5" width="14" height="14" rx="2" stroke={color} strokeWidth={strokeWidth} />
    </svg>
  );
}

export function ThemeIcon({
  size = 16,
  color = "currentColor",
  strokeWidth = 1.5,
  style,
}: IconProps) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" style={style}>
      <circle cx="12" cy="12" r="9" stroke={color} strokeWidth={strokeWidth} />
      <path d="M12 3a9 9 0 0 1 0 18Z" fill={color} />
    </svg>
  );
}

export function DotsIcon({ size = 16, color = "currentColor", style }: IconProps) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill={color} style={style}>
      <circle cx="5" cy="12" r="1.5" />
      <circle cx="12" cy="12" r="1.5" />
      <circle cx="19" cy="12" r="1.5" />
    </svg>
  );
}

export function SidebarIcon({
  size = 20,
  color = "currentColor",
  strokeWidth = 1.5,
  style,
}: IconProps) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" style={style}>
      <rect x="3" y="3" width="18" height="18" rx="2" stroke={color} strokeWidth={strokeWidth} />
      <path d="M9 3v18" stroke={color} strokeWidth={strokeWidth} strokeLinecap="round" />
    </svg>
  );
}

export function RotateIcon({
  size = 16,
  color = "currentColor",
  strokeWidth = 1.67,
  style,
}: IconProps) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" style={style}>
      <rect
        x="4.1"
        y="8"
        width="9"
        height="11.6"
        rx="2.3"
        stroke={color}
        strokeWidth={strokeWidth}
      />
      <path
        d="M8.6 4.1A9.7 9.7 0 0 1 18.3 13.8M16.18 11.68 18.3 13.8 20.42 11.68"
        stroke={color}
        strokeWidth={strokeWidth}
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </svg>
  );
}

export function PowerIcon({
  size = 16,
  color = "currentColor",
  strokeWidth = 1.67,
  style,
}: IconProps) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" style={style}>
      <path d="M12 2v10" stroke={color} strokeWidth={strokeWidth} strokeLinecap="round" />
      <path
        d="M18.36 6.64a9 9 0 1 1-12.73 0"
        stroke={color}
        strokeWidth={strokeWidth}
        strokeLinecap="round"
      />
    </svg>
  );
}

/**
 * Vendored Lucide `unplug` icon, rendered locally to keep this package dependency-free.
 *
 * @license ISC
 * Copyright (c) 2026 Lucide Icons and Contributors
 * Permission to use, copy, modify, and/or distribute this software for any purpose
 * with or without fee is hereby granted, provided that the above copyright notice
 * and this permission notice appear in all copies.
 * THE SOFTWARE IS PROVIDED "AS IS" AND THE AUTHOR DISCLAIMS ALL WARRANTIES WITH
 * REGARD TO THIS SOFTWARE INCLUDING ALL IMPLIED WARRANTIES OF MERCHANTABILITY AND
 * FITNESS. IN NO EVENT SHALL THE AUTHOR BE LIABLE FOR ANY SPECIAL, DIRECT, INDIRECT,
 * OR CONSEQUENTIAL DAMAGES OR ANY DAMAGES WHATSOEVER RESULTING FROM LOSS OF USE,
 * DATA OR PROFITS, WHETHER IN AN ACTION OF CONTRACT, NEGLIGENCE OR OTHER TORTIOUS
 * ACTION, ARISING OUT OF OR IN CONNECTION WITH THE USE OR PERFORMANCE OF THIS SOFTWARE.
 */
export function CableDisconnectIcon({
  size = 16,
  color = "currentColor",
  strokeWidth = 1.67,
  style,
}: IconProps) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" style={style}>
      <path
        d="m19 5 3-3"
        stroke={color}
        strokeWidth={strokeWidth}
        strokeLinecap="round"
        strokeLinejoin="round"
      />
      <path
        d="m2 22 3-3"
        stroke={color}
        strokeWidth={strokeWidth}
        strokeLinecap="round"
        strokeLinejoin="round"
      />
      <path
        d="M6.3 20.3a2.4 2.4 0 0 0 3.4 0L12 18l-6-6-2.3 2.3a2.4 2.4 0 0 0 0 3.4Z"
        stroke={color}
        strokeWidth={strokeWidth}
        strokeLinecap="round"
        strokeLinejoin="round"
      />
      <path
        d="M7.5 13.5 10 11"
        stroke={color}
        strokeWidth={strokeWidth}
        strokeLinecap="round"
        strokeLinejoin="round"
      />
      <path
        d="M10.5 16.5 13 14"
        stroke={color}
        strokeWidth={strokeWidth}
        strokeLinecap="round"
        strokeLinejoin="round"
      />
      <path
        d="m12 6 6 6 2.3-2.3a2.4 2.4 0 0 0 0-3.4l-2.6-2.6a2.4 2.4 0 0 0-3.4 0Z"
        stroke={color}
        strokeWidth={strokeWidth}
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </svg>
  );
}

export function TrashIcon({
  size = 16,
  color = "currentColor",
  strokeWidth = 1.67,
  style,
}: IconProps) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" style={style}>
      <path
        d="M3 6h18M8 6V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2M19 6l-1 14a2 2 0 0 1-2 2H8a2 2 0 0 1-2-2L5 6M10 11v6M14 11v6"
        stroke={color}
        strokeWidth={strokeWidth}
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </svg>
  );
}

/** Lucide `clipboard-paste` — the toolbar's Paste from Device button. */
export function ClipboardPasteIcon({
  size = 16,
  color = "currentColor",
  strokeWidth = 2,
  style,
}: IconProps) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" style={style}>
      <path
        d="M11 14h10M16 4h2a2 2 0 0 1 2 2v1.344M17 18l4-4-4-4M8 4H6a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h12a2 2 0 0 0 1.793-1.113"
        stroke={color}
        strokeWidth={strokeWidth}
        strokeLinecap="round"
        strokeLinejoin="round"
      />
      <rect
        x="8"
        y="2"
        width="8"
        height="4"
        rx="1"
        stroke={color}
        strokeWidth={strokeWidth}
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </svg>
  );
}

/** Lucide `copy` — the toolbar's Copy from Simulator button. */
export function CopyIcon({ size = 16, color = "currentColor", strokeWidth = 2, style }: IconProps) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" style={style}>
      <rect
        x="8"
        y="8"
        width="14"
        height="14"
        rx="2"
        stroke={color}
        strokeWidth={strokeWidth}
        strokeLinecap="round"
        strokeLinejoin="round"
      />
      <path
        d="M4 16c-1.1 0-2-.9-2-2V4c0-1.1.9-2 2-2h10c1.1 0 2 .9 2 2"
        stroke={color}
        strokeWidth={strokeWidth}
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </svg>
  );
}

/** Lucide `smartphone` — the device glyph in the add-device picker's recent rows. */
export function SmartphoneIcon({
  size = 16,
  color = "currentColor",
  strokeWidth = 2,
  style,
}: IconProps) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" style={style}>
      <rect
        x="5"
        y="2"
        width="14"
        height="20"
        rx="2.5"
        stroke={color}
        strokeWidth={strokeWidth}
        strokeLinecap="round"
        strokeLinejoin="round"
      />
      <path
        d="M12 18h.01"
        stroke={color}
        strokeWidth={strokeWidth}
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </svg>
  );
}

/** Lucide `triangle-alert` — warning marker for unsupported or untested devices. */
export function WarningIcon({
  size = 16,
  color = "currentColor",
  strokeWidth = 2,
  style,
}: IconProps) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      aria-hidden="true"
      focusable="false"
      style={style}
    >
      <path
        d="M10.3 3.9 1.8 18a2 2 0 0 0 1.7 3h17a2 2 0 0 0 1.7-3L13.7 3.9a2 2 0 0 0-3.4 0Z"
        stroke={color}
        strokeWidth={strokeWidth}
        strokeLinecap="round"
        strokeLinejoin="round"
      />
      <path
        d="M12 9v4M12 17h.01"
        stroke={color}
        strokeWidth={strokeWidth}
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </svg>
  );
}

/** Lucide `check` — trailing mark on the selected recent row. */
export function CheckIcon({
  size = 17,
  color = "currentColor",
  strokeWidth = 2.5,
  style,
}: IconProps) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" style={style}>
      <polyline
        points="20 6 9 17 4 12"
        stroke={color}
        strokeWidth={strokeWidth}
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </svg>
  );
}

/** Lucide `chevron-down` — trailing affordance on the OS-version select. */
export function ChevronDownIcon({
  size = 14,
  color = "currentColor",
  strokeWidth = 2,
  style,
}: IconProps) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" style={style}>
      <polyline
        points="6 9 12 15 18 9"
        stroke={color}
        strokeWidth={strokeWidth}
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </svg>
  );
}

/** Lucide `chevron-right` — trailing affordance on the screenshot toast. */
export function ChevronRightIcon({
  size = 16,
  color = "currentColor",
  strokeWidth = 2.25,
  style,
}: IconProps) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" style={style}>
      <polyline
        points="9 18 15 12 9 6"
        stroke={color}
        strokeWidth={strokeWidth}
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </svg>
  );
}

/** Lucide `chevrons-up-down` — trailing affordance on the Model select. */
export function ChevronsUpDownIcon({
  size = 14,
  color = "currentColor",
  strokeWidth = 2,
  style,
}: IconProps) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" style={style}>
      <polyline
        points="7 15 12 20 17 15"
        stroke={color}
        strokeWidth={strokeWidth}
        strokeLinecap="round"
        strokeLinejoin="round"
      />
      <polyline
        points="7 9 12 4 17 9"
        stroke={color}
        strokeWidth={strokeWidth}
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </svg>
  );
}

/** A keyboard with an arrow rising from it: the control brings the device keyboard up. */
export function KeyboardIcon({ size = 20, color = "currentColor", strokeWidth = 1.67 }: IconProps) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" aria-hidden="true">
      <rect x="3" y="11" width="18" height="10" rx="2" stroke={color} strokeWidth={strokeWidth} />
      <path
        d="M7 14h1m3 0h1m3 0h1M8 18h8"
        stroke={color}
        strokeWidth={strokeWidth}
        strokeLinecap="round"
      />
      <path
        d="M12 8V3M9.5 5.5 12 3l2.5 2.5"
        stroke={color}
        strokeWidth={strokeWidth}
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </svg>
  );
}

export function FullScreenIcon({
  size = 20,
  color = "currentColor",
  strokeWidth = 1.67,
}: IconProps) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" aria-hidden="true">
      <path
        d="M8 3H3v5m13-5h5v5M3 16v5h5m13-5v5h-5"
        stroke={color}
        strokeWidth={strokeWidth}
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </svg>
  );
}

/*
 * Toolbar icons with the glyphs of the website's device controls. The first
 * four are the outline icons of `@expo/styleguide-icons`, which draw a filled
 * path. The last two are the website's own `TriangleBackIcon` and
 * `KeyboardDismissIcon`, which draw a 2px stroke of the same weight.
 */
type GlyphIconProps = Pick<IconProps, "size" | "color" | "style">;

function OutlineGlyph({
  d,
  size = 20,
  color = "currentColor",
  style,
}: GlyphIconProps & { d: string }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill={color} style={style}>
      <path d={d} />
    </svg>
  );
}

/** `Home01Icon` of the styleguide. */
export function HomeIcon(props: GlyphIconProps) {
  return (
    <OutlineGlyph
      {...props}
      d="M20 10.5648C20 9.93408 19.9912 9.8095 19.9629 9.70832C19.9301 9.59131 19.876 9.48082 19.8037 9.38312C19.7412 9.29877 19.6476 9.21518 19.1504 8.82843L12.3682 3.55304C12.1815 3.40783 12.082 3.33174 12.0068 3.28156C12.0044 3.27993 12.0022 3.27814 12 3.27668C11.9978 3.27814 11.9956 3.27993 11.9932 3.28156C11.9181 3.33174 11.8186 3.40782 11.6318 3.55304L4.84961 8.82843C4.35237 9.21518 4.25878 9.29877 4.19629 9.38312C4.12404 9.48082 4.06991 9.59131 4.03711 9.70832C4.00879 9.8095 4.00001 9.93408 4.00001 10.5648V17.8001C4.00001 18.3766 4.00127 18.7492 4.02442 19.0325C4.04662 19.3039 4.0842 19.405 4.10938 19.4544C4.20525 19.6423 4.35796 19.7951 4.5459 19.8909C4.59534 19.9161 4.69618 19.9537 4.96778 19.9759C5.25112 19.999 5.62365 20.0003 6.2002 20.0003H17.7998C18.3764 20.0003 18.7489 19.999 19.0322 19.9759C19.3038 19.9537 19.4047 19.9161 19.4541 19.8909C19.6421 19.7951 19.7948 19.6423 19.8906 19.4544C19.9158 19.405 19.9534 19.3039 19.9756 19.0325C19.9987 18.7492 20 18.3766 20 17.8001V10.5648ZM22 17.8001C22 18.3434 22.001 18.8111 21.9697 19.1946C21.9374 19.5899 21.8656 19.9833 21.6729 20.3616C21.3853 20.926 20.9267 21.3855 20.3623 21.6732C19.984 21.8659 19.5906 21.9367 19.1953 21.9691C18.8116 22.0004 18.3434 22.0003 17.7998 22.0003H6.2002C5.65665 22.0003 5.18836 22.0004 4.80469 21.9691C4.40945 21.9367 4.01598 21.8659 3.6377 21.6732C3.07332 21.3855 2.61473 20.926 2.32715 20.3616C2.13445 19.9833 2.06257 19.5899 2.03028 19.1946C1.99897 18.8111 2.00001 18.3434 2.00001 17.8001V10.5648C2 10.0472 1.99163 9.59689 2.11133 9.16925C2.20967 8.81811 2.37109 8.48785 2.5879 8.19464C2.85193 7.83766 3.21262 7.56801 3.6211 7.25031L10.4033 1.97492C10.6817 1.75844 11.0422 1.45411 11.4775 1.33625C11.777 1.25521 12.0906 1.24517 12.3936 1.30597L12.5225 1.33625L12.6826 1.38898C13.0468 1.5291 13.3532 1.78555 13.5967 1.97492L20.3789 7.25031C20.7874 7.56801 21.1481 7.83766 21.4121 8.19464C21.6289 8.48785 21.7903 8.81811 21.8887 9.16925C22.0084 9.59689 22 10.0472 22 10.5648V17.8001Z"
    />
  );
}

/** `Camera01Icon` of the styleguide. */
export function CameraIcon(props: GlyphIconProps) {
  return (
    <OutlineGlyph
      {...props}
      d="M21 8.37695C21 8.00291 20.9988 7.88867 20.9902 7.80273C20.8962 6.85417 20.1458 6.10378 19.1973 6.00977C19.1117 6.00128 18.9893 6 18.5947 6C18.467 6 18.358 6.00009 18.2598 5.99414C17.1032 5.92393 16.0905 5.19423 15.6582 4.11914C15.6217 4.02821 15.5897 3.93025 15.5518 3.81641C15.5054 3.67724 15.4949 3.64822 15.4863 3.62695C15.3423 3.2686 15.0047 3.02538 14.6192 3.00195C14.5963 3.00057 14.5656 3 14.419 3H9.58107C9.43444 3 9.40375 3.00057 9.38087 3.00195C8.99536 3.02538 8.65776 3.2686 8.51368 3.62695C8.50513 3.64822 8.49465 3.67723 8.44825 3.81641C8.41031 3.93025 8.37837 4.02821 8.34181 4.11914C7.90953 5.19423 6.89684 5.92393 5.74025 5.99414C5.64206 6.00009 5.53302 6 5.40529 6C5.01074 6 4.88835 6.00128 4.80275 6.00977C3.85418 6.10378 3.1038 6.85417 3.00978 7.80273C3.00126 7.88867 3.00001 8.00291 3.00001 8.37695V16.2002C3.00001 17.0566 3.00036 17.6388 3.03712 18.0889C3.07294 18.5273 3.1381 18.7518 3.21779 18.9082C3.40952 19.2845 3.71556 19.5905 4.09181 19.7822C4.24821 19.8619 4.47273 19.9271 4.91115 19.9629C5.36118 19.9997 5.94343 20 6.79982 20H17.2002C18.0566 20 18.6388 19.9997 19.0889 19.9629C19.5273 19.9271 19.7518 19.8619 19.9082 19.7822C20.2845 19.5905 20.5905 19.2845 20.7822 18.9082C20.8619 18.7518 20.9271 18.5273 20.9629 18.0889C20.9997 17.6388 21 17.0566 21 16.2002V8.37695ZM15 12.5C15 10.8431 13.6569 9.5 12 9.5C10.3432 9.5 9.00001 10.8431 9.00001 12.5C9.00001 14.1569 10.3432 15.5 12 15.5C13.6569 15.5 15 14.1569 15 12.5ZM17 12.5C17 15.2614 14.7614 17.5 12 17.5C9.23859 17.5 7.00001 15.2614 7.00001 12.5C7.00001 9.73858 9.23859 7.5 12 7.5C14.7614 7.5 17 9.73858 17 12.5ZM23 16.2002C23 17.0237 23.001 17.7016 22.9561 18.252C22.9101 18.814 22.8117 19.3311 22.5645 19.8164C22.181 20.5689 21.5689 21.181 20.8164 21.5645C20.3311 21.8117 19.814 21.9101 19.252 21.9561C18.7016 22.001 18.0237 22 17.2002 22H6.79982C5.97633 22 5.29844 22.001 4.74806 21.9561C4.186 21.9101 3.66891 21.8117 3.18361 21.5645C2.4311 21.181 1.81903 20.5689 1.43556 19.8164C1.18828 19.3311 1.08989 18.814 1.04396 18.252C0.99899 17.7016 1.00001 17.0237 1.00001 16.2002V8.37695C1.00001 8.05071 0.998831 7.81452 1.01954 7.60547C1.20758 5.70833 2.70834 4.20757 4.60548 4.01953C4.81486 3.99879 5.06179 4 5.40529 4C5.56209 4 5.59655 3.99942 5.61915 3.99805C6.00466 3.97462 6.34226 3.7314 6.48634 3.37305C6.49489 3.35178 6.50538 3.32277 6.55177 3.18359C6.58972 3.06975 6.62166 2.97179 6.65822 2.88086C7.0905 1.80577 8.10318 1.07607 9.25978 1.00586C9.35767 0.999931 9.46097 1 9.58107 1H14.419C14.5391 1 14.6424 0.999931 14.7402 1.00586C15.8968 1.07607 16.9095 1.80577 17.3418 2.88086C17.3784 2.97179 17.4103 3.06975 17.4483 3.18359C17.4946 3.32276 17.5051 3.35178 17.5137 3.37305C17.6578 3.7314 17.9954 3.97462 18.3809 3.99805C18.4035 3.99942 18.4379 4 18.5947 4C18.9382 4 19.1852 3.99879 19.3945 4.01953C21.2917 4.20757 22.7924 5.70833 22.9805 7.60547C23.0012 7.81452 23 8.05071 23 8.37695V16.2002Z"
    />
  );
}

/** `RefreshCw01Icon` of the styleguide. */
export function ReloadIcon(props: GlyphIconProps) {
  return (
    <OutlineGlyph
      {...props}
      d="M2 12C2 6.47715 6.47715 2 12 2C14.7624 2 17.2645 3.12166 19.0732 4.93164C19.7128 5.5716 20.3982 6.3619 21 7.09375V4C21 3.44772 21.4477 3 22 3C22.5523 3 23 3.44772 23 4V10C23 10.5523 22.5523 11 22 11H16C15.4477 11 15 10.5523 15 10C15 9.44772 15.4477 9 16 9H19.9678C19.2756 8.13143 18.4167 7.10277 17.6592 6.34473C16.2102 4.89477 14.2104 4 12 4C7.58172 4 4 7.58172 4 12C4 16.4183 7.58172 20 12 20C15.6457 20 18.7244 17.5604 19.6875 14.2227C19.8407 13.6921 20.3952 13.386 20.9258 13.5391C21.4563 13.6923 21.7625 14.2468 21.6094 14.7773C20.4058 18.9482 16.5605 22 12 22C6.47715 22 2 17.5228 2 12Z"
    />
  );
}

/** `SquareIcon` of the styleguide: Android's recent apps button. */
export function SquareIcon(props: GlyphIconProps) {
  return (
    <OutlineGlyph
      {...props}
      d="M20 7.79981C20 6.94342 19.9997 6.36117 19.9629 5.91113C19.9271 5.47272 19.8619 5.2482 19.7822 5.0918C19.5905 4.71555 19.2845 4.40951 18.9082 4.21778C18.7518 4.13809 18.5273 4.07293 18.0889 4.03711C17.6388 4.00035 17.0566 4 16.2002 4H7.79981C6.94342 4 6.36117 4.00035 5.91113 4.03711C5.47272 4.07293 5.2482 4.13809 5.0918 4.21778C4.71555 4.40951 4.40951 4.71555 4.21778 5.0918C4.13809 5.2482 4.07293 5.47272 4.03711 5.91113C4.00035 6.36117 4 6.94342 4 7.79981V16.2002C4 17.0566 4.00035 17.6388 4.03711 18.0889C4.07293 18.5273 4.13809 18.7518 4.21778 18.9082C4.40951 19.2845 4.71555 19.5905 5.0918 19.7822C5.2482 19.8619 5.47272 19.9271 5.91113 19.9629C6.36117 19.9997 6.94342 20 7.79981 20H16.2002C17.0566 20 17.6388 19.9997 18.0889 19.9629C18.5273 19.9271 18.7518 19.8619 18.9082 19.7822C19.2845 19.5905 19.5905 19.2845 19.7822 18.9082C19.8619 18.7518 19.9271 18.5273 19.9629 18.0889C19.9997 17.6388 20 17.0566 20 16.2002V7.79981ZM22 16.2002C22 17.0237 22.001 17.7016 21.9561 18.252C21.9101 18.814 21.8117 19.3311 21.5645 19.8164C21.181 20.5689 20.5689 21.181 19.8164 21.5645C19.3311 21.8117 18.814 21.9101 18.252 21.9561C17.7016 22.001 17.0237 22 16.2002 22H7.79981C6.97632 22 6.29843 22.001 5.74805 21.9561C5.18599 21.9101 4.6689 21.8117 4.1836 21.5645C3.43109 21.181 2.81902 20.5689 2.43555 19.8164C2.18827 19.3311 2.08988 18.814 2.04395 18.252C1.99898 17.7016 2 17.0237 2 16.2002V7.79981C2 6.97632 1.99898 6.29843 2.04395 5.74805C2.08988 5.18599 2.18827 4.6689 2.43555 4.1836C2.81902 3.43109 3.43109 2.81902 4.1836 2.43555C4.6689 2.18827 5.18599 2.08988 5.74805 2.04395C6.29843 1.99898 6.97632 2 7.79981 2H16.2002C17.0237 2 17.7016 1.99898 18.252 2.04395C18.814 2.08988 19.3311 2.18827 19.8164 2.43555C20.5689 2.81902 21.181 3.43109 21.5645 4.1836C21.8117 4.6689 21.9101 5.18599 21.9561 5.74805C22.001 6.29843 22 6.97632 22 7.79981V16.2002Z"
    />
  );
}

/** Android's back button: an outline triangle that points left. */
export function TriangleBackIcon({ size = 20, color = "currentColor", style }: GlyphIconProps) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" style={style}>
      <path
        d="M19.5 5.2V18.8Q19.5 22 16.74 20.38L5.26 13.62Q2.5 12 5.26 10.38L16.74 3.62Q19.5 2 19.5 5.2Z"
        stroke={color}
        strokeWidth={2}
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </svg>
  );
}

/** A short keyboard with a down chevron under it: dismiss the on-screen keyboard. */
export function KeyboardDismissIcon({ size = 20, color = "currentColor", style }: GlyphIconProps) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" style={style}>
      <g stroke={color} strokeWidth={2} strokeLinecap="round" strokeLinejoin="round">
        <rect x="2" y="2.5" width="20" height="11" rx="3" />
        <path d="M6 6.5H6.01M10 6.5H10.01M14 6.5H14.01M18 6.5H18.01M8 10H8.01M12 10H12.01M16 10H16.01" />
        <path d="M9 18L12 21L15 18" />
      </g>
    </svg>
  );
}

/*
 * Platform marks of the device list, from the dashboard design. Each path keeps
 * the coordinates of its design frame; the `viewBox` is the 16px icon box
 * around it.
 */

/** The Apple logo: a simulator. */
export function AppleIcon({ size = 16, color = "currentColor", style }: GlyphIconProps) {
  return (
    <svg width={size} height={size} viewBox="24 61 16 16" fill={color} style={style}>
      <path d="M37.6316 72.5693C37.4205 73.0569 37.1707 73.5058 36.8812 73.9184C36.4866 74.481 36.1636 74.8704 35.9146 75.0867C35.5286 75.4416 35.1151 75.6234 34.6723 75.6337C34.3544 75.6337 33.971 75.5433 33.5247 75.3598C33.077 75.1771 32.6655 75.0867 32.2893 75.0867C31.8947 75.0867 31.4715 75.1771 31.0189 75.3598C30.5655 75.5433 30.2003 75.6389 29.9211 75.6484C29.4965 75.6665 29.0732 75.4795 28.6507 75.0867C28.381 74.8515 28.0437 74.4483 27.6397 73.8771C27.2062 73.2671 26.8497 72.5598 26.5705 71.7534C26.2715 70.8824 26.1216 70.039 26.1216 69.2224C26.1216 68.287 26.3237 67.4803 26.7285 66.8043C27.0467 66.2612 27.47 65.8329 27.9997 65.5184C28.5295 65.204 29.1019 65.0437 29.7183 65.0335C30.0556 65.0335 30.4979 65.1378 31.0475 65.3429C31.5957 65.5486 31.9476 65.6529 32.1019 65.6529C32.2172 65.6529 32.6082 65.5309 33.271 65.2877C33.8977 65.0622 34.4267 64.9688 34.8601 65.0056C36.0343 65.1003 36.9165 65.5632 37.5032 66.3972C36.453 67.0335 35.9335 67.9248 35.9439 69.0681C35.9534 69.9587 36.2764 70.6998 36.9114 71.2882C37.1991 71.5613 37.5205 71.7724 37.878 71.9223C37.8005 72.1471 37.7186 72.3625 37.6316 72.5693V72.5693ZM34.9385 61.9716C34.9385 62.6696 34.6835 63.3214 34.1752 63.9246C33.5617 64.6417 32.8198 65.0561 32.0152 64.9907C32.005 64.907 31.999 64.8189 31.999 64.7263C31.999 64.0562 32.2907 63.339 32.8088 62.7527C33.0674 62.4558 33.3963 62.2089 33.7952 62.012C34.1932 61.818 34.5697 61.7108 34.9238 61.6924C34.9342 61.7857 34.9385 61.879 34.9385 61.9716V61.9716Z" />
    </svg>
  );
}

/** The Android head: an emulator or a connected Android device. */
export function AndroidIcon({ size = 16, color = "currentColor", style }: GlyphIconProps) {
  return (
    <svg width={size} height={size} viewBox="24 45 16 16" fill={color} style={style}>
      <path d="M35.375 55.0486C35.0382 55.0486 34.7643 54.7736 34.7643 54.4358C34.7643 54.0979 35.0382 53.8231 35.375 53.8231C35.7118 53.8231 35.9857 54.0979 35.9857 54.4358C35.9857 54.7736 35.7118 55.0486 35.375 55.0486ZM28.6246 55.0486C28.2879 55.0486 28.0139 54.7736 28.0139 54.4358C28.0139 54.0979 28.2879 53.8231 28.6246 53.8231C28.9614 53.8231 29.2353 54.0979 29.2353 54.4358C29.2353 54.7736 28.9614 55.0486 28.6246 55.0486ZM35.594 51.358L36.8146 49.2373C36.8846 49.1154 36.843 48.9597 36.7217 48.8893C36.6004 48.8191 36.445 48.8609 36.3748 48.9826L35.1389 51.1301C34.1939 50.6974 33.1324 50.4564 31.9998 50.4564C30.8672 50.4564 29.8058 50.6974 28.8607 51.1301L27.6248 48.9826C27.5547 48.8609 27.3993 48.8191 27.278 48.8893C27.1567 48.9597 27.1148 49.1154 27.185 49.2373L28.4056 51.358C26.3097 52.5016 24.8762 54.6302 24.6665 57.1451H39.3331C39.1232 54.6302 37.6898 52.5016 35.594 51.358Z" />
    </svg>
  );
}
