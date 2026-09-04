/**
 * `@expo/hub-components` — the dependency-free UI kit shared by Expo Hub and the
 * Expo dashboard website (`universe/server/website`).
 *
 * Components are ports of the website's `ui/components/*`, driving the same
 * `@expo/styleguide` design tokens. Two styling strategies coexist, matching the
 * originals:
 *   - Inline-style components ({@link Button}, {@link ControlButton}, …) read the
 *     typed tokens from `./theme/tokens` (CSS custom properties), so they work in
 *     any environment that defines the `--expo-theme-*` variables.
 *   - Radix + Tailwind components ({@link Dropdown}, {@link Dialog}, …) rely on the
 *     consumer providing the styleguide utility classes (the website's Tailwind
 *     preset, or Expo Hub's `global.css`).
 *
 * The CSS variables themselves are not bundled here — import them from the
 * consumer's design system, or use the `@expo/hub-components/theme.css` copy.
 */

// ── Components ──
export { Button, type ButtonProps, type ButtonTheme, type ButtonSize } from './components/Button';
export { ControlButton, type ControlButtonProps } from './components/ControlButton';
export { DeviceListItem, type DeviceListItemProps } from './components/DeviceListItem';
export {
  DialogRoot,
  DialogContent,
  DialogTitle,
  DialogContentContainer,
  DialogFooter,
  DialogClose,
} from './components/Dialog';
// Kept for the website: Expo Hub no longer renders `Dropdown`, `DropdownItem`,
// `SegmentedControl`, `Switch`, or `StreamSection` (its inspector uses `Select`
// pills, and the stream toolbar has no menu). Delete them once the website
// confirms it does not import them either.
export { Dropdown } from './components/Dropdown';
export { DropdownItem } from './components/DropdownItem';
export { Logo } from './components/Logo';
export { PillButton, type PillButtonProps } from './components/PillButton';
export { ResizeHandle } from './components/ResizeHandle';
export {
  SegmentedControl,
  type SegmentedControlOption,
} from './components/SegmentedControl';
export { Select, type SelectOption, type SelectProps } from './components/Select';
export { SidebarToggle } from './components/SidebarToggle';
export { Switch, type SwitchProps } from './components/Switch';
export { cx } from './components/cx';
export { usePrefersReducedMotion } from './components/usePrefersReducedMotion';
export * from './components/icons';

// ── Design tokens ──
export * from './theme/tokens';

// ── Dashboard composites ──
// These compose the primitives above into the Expo Hub dashboard layout. The
// device stream is injected: `StreamPanel` / `PhoneFrame` take the `DeviceScreen`
// component + `displayScreen` helper as props (typed from `@expo/hub-client`, a
// types-only devDependency) so this library never imports the client at runtime.
export { Sidebar } from './dashboard/Sidebar';
export { LogSidebar, type LogSidebarProps } from './dashboard/LogSidebar';
export { StreamPanel } from './dashboard/StreamPanel';
export { DeviceTitle, type DeviceTitleProps } from './dashboard/DeviceTitle';
export { EmptyState } from './dashboard/EmptyState';
export { DeviceSection, type DeviceSectionProps } from './dashboard/DeviceSection';
export { OutputSection } from './dashboard/OutputSection';
export { CurrentAppSection } from './dashboard/CurrentAppSection';
export {
  DeviceOptionsSection,
  NO_DEVICE_FRAME_DESCRIPTION,
  type DeviceFrameOption,
} from './dashboard/DeviceOptionsSection';
export { ActivityCharts, ActivitySection } from './dashboard/ActivitySection';
export { EventsSection } from './dashboard/EventsSection';
export { LogsSection } from './dashboard/LogsSection';
export { CollapsibleSection } from './dashboard/CollapsibleSection';
export { KeyboardSection } from './dashboard/KeyboardSection';
export { PhoneFrame } from './dashboard/PhoneFrame';
export {
  deviceFrameLayout,
  deviceFrameRotation,
  type DeviceFrameAsset,
  type DeviceFrameAssets,
  type DeviceFrameLayout,
  type DeviceFrameRect,
  type DeviceFrameRotation,
} from './dashboard/deviceFrame';
export { LogControls } from './dashboard/LogControls';
export { LogList } from './dashboard/LogList';
export { LogRow } from './dashboard/LogRow';
export { StreamControls } from './dashboard/StreamControls';
export {
  StreamSection,
  type StreamModeAvailability,
} from './dashboard/StreamSection';
export {
  StreamOptionsSection,
  type StreamOptionsSectionProps,
} from './dashboard/StreamOptionsSection';
export { RecentDevicesModal, type RecentDevicesModalProps } from './dashboard/RecentDevicesModal';
export { BootErrorModal, type BootErrorModalProps } from './dashboard/BootErrorModal';
export {
  ServerConnectionOverlay,
  type ServerConnectionOverlayProps,
} from './dashboard/ServerConnectionOverlay';

// ── Shared dashboard types + config ──
export * from './dashboard/data';
