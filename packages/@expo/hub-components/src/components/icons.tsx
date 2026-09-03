import { type CSSProperties } from 'react';

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

export function PlusIcon({ size = 18, color = 'currentColor', strokeWidth = 1.5, style }: IconProps) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" style={style}>
      <path d="M12 5v14M5 12h14" stroke={color} strokeWidth={strokeWidth} strokeLinecap="round" />
    </svg>
  );
}

export function CloseIcon({ size = 18, color = 'currentColor', strokeWidth = 1.67, style }: IconProps) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" style={style}>
      <path d="M18 6 6 18M6 6l12 12" stroke={color} strokeWidth={strokeWidth} strokeLinecap="round" />
    </svg>
  );
}

export function PhoneIcon({ size = 28, color = 'currentColor', strokeWidth = 1.5, style }: IconProps) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" style={style}>
      <rect x="6" y="2" width="12" height="20" rx="3" stroke={color} strokeWidth={strokeWidth} />
      <path d="M10 18.5h4" stroke={color} strokeWidth={strokeWidth} strokeLinecap="round" />
    </svg>
  );
}

export function RefreshIcon({ size = 16, color = 'currentColor', strokeWidth = 1.5, style }: IconProps) {
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

export function HomeIcon({ size = 20, color = 'currentColor', strokeWidth = 1.67, style }: IconProps) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" style={style}>
      <path
        d="M3 9.5 12 3l9 6.5V20a1 1 0 0 1-1 1h-5v-6H9v6H4a1 1 0 0 1-1-1V9.5Z"
        stroke={color}
        strokeWidth={strokeWidth}
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </svg>
  );
}

export function BackIcon({ size = 18, color = 'currentColor', strokeWidth = 1.67, style }: IconProps) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" style={style}>
      <path d="M19 12H5M12 19l-7-7 7-7" stroke={color} strokeWidth={strokeWidth} strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  );
}

export function RecentsIcon({ size = 16, color = 'currentColor', strokeWidth = 1.67, style }: IconProps) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" style={style}>
      <rect x="5" y="5" width="14" height="14" rx="2" stroke={color} strokeWidth={strokeWidth} />
    </svg>
  );
}

export function ThemeIcon({ size = 16, color = 'currentColor', strokeWidth = 1.5, style }: IconProps) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" style={style}>
      <circle cx="12" cy="12" r="9" stroke={color} strokeWidth={strokeWidth} />
      <path d="M12 3a9 9 0 0 1 0 18Z" fill={color} />
    </svg>
  );
}

export function CameraIcon({ size = 16, color = 'currentColor', strokeWidth = 1.33, style }: IconProps) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" style={style}>
      <path
        d="M3 8a2 2 0 0 1 2-2h1.5L8 4h8l1.5 2H19a2 2 0 0 1 2 2v9a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V8Z"
        stroke={color}
        strokeWidth={strokeWidth}
        strokeLinecap="round"
        strokeLinejoin="round"
      />
      <circle cx="12" cy="13" r="3.25" stroke={color} strokeWidth={strokeWidth} />
    </svg>
  );
}

export function DotsIcon({ size = 16, color = 'currentColor', style }: IconProps) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill={color} style={style}>
      <circle cx="5" cy="12" r="1.5" />
      <circle cx="12" cy="12" r="1.5" />
      <circle cx="19" cy="12" r="1.5" />
    </svg>
  );
}

export function SidebarIcon({ size = 20, color = 'currentColor', strokeWidth = 1.5, style }: IconProps) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" style={style}>
      <rect x="3" y="3" width="18" height="18" rx="2" stroke={color} strokeWidth={strokeWidth} />
      <path d="M9 3v18" stroke={color} strokeWidth={strokeWidth} strokeLinecap="round" />
    </svg>
  );
}

export function RotateIcon({ size = 16, color = 'currentColor', strokeWidth = 1.67, style }: IconProps) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" style={style}>
      <rect x="4.1" y="8" width="9" height="11.6" rx="2.3" stroke={color} strokeWidth={strokeWidth} />
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

export function PowerIcon({ size = 16, color = 'currentColor', strokeWidth = 1.67, style }: IconProps) {
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
  color = 'currentColor',
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

export function TrashIcon({ size = 16, color = 'currentColor', strokeWidth = 1.67, style }: IconProps) {
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

/** Lucide `smartphone` — the device glyph in the add-device picker's recent rows. */
export function SmartphoneIcon({ size = 16, color = 'currentColor', strokeWidth = 2, style }: IconProps) {
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
      <path d="M12 18h.01" stroke={color} strokeWidth={strokeWidth} strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  );
}

/** Lucide `triangle-alert` — warning marker for unsupported or untested devices. */
export function WarningIcon({ size = 16, color = 'currentColor', strokeWidth = 2, style }: IconProps) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      aria-hidden="true"
      focusable="false"
      style={style}>
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
export function CheckIcon({ size = 17, color = 'currentColor', strokeWidth = 2.5, style }: IconProps) {
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
export function ChevronDownIcon({ size = 14, color = 'currentColor', strokeWidth = 2, style }: IconProps) {
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

/** Lucide `chevrons-up-down` — trailing affordance on the Model select. */
export function ChevronsUpDownIcon({ size = 14, color = 'currentColor', strokeWidth = 2, style }: IconProps) {
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
