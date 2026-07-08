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
export { Dropdown } from './components/Dropdown';
export { DropdownItem } from './components/DropdownItem';
export { Logo } from './components/Logo';
export { SidebarToggle } from './components/SidebarToggle';
export { Switch, type SwitchProps } from './components/Switch';
export { cx } from './components/cx';
export * from './components/icons';

// ── Design tokens ──
export * from './theme/tokens';

// ── Dashboard composites ──
// These compose the primitives above into the Expo Hub dashboard layout. The
// device stream is injected: `StreamPanel` / `PhoneFrame` take the `DeviceScreen`
// component + `displayScreen` helper as props (typed from `@expo/hub-client`, a
// types-only devDependency) so this library never imports the client at runtime.
export { Sidebar } from './dashboard/Sidebar';
export { LogSidebar } from './dashboard/LogSidebar';
export { StreamPanel } from './dashboard/StreamPanel';
export { EmptyState } from './dashboard/EmptyState';
export { DeviceSection, type DeviceSectionProps } from './dashboard/DeviceSection';
export { OutputSection } from './dashboard/OutputSection';
export { PhoneFrame } from './dashboard/PhoneFrame';
export { TabBar } from './dashboard/TabBar';
export { LogControls } from './dashboard/LogControls';
export { LogList } from './dashboard/LogList';
export { LogRow } from './dashboard/LogRow';
export { StreamControls } from './dashboard/StreamControls';
export { RecentDevicesModal, type RecentDevicesModalProps } from './dashboard/RecentDevicesModal';

// ── Shared dashboard types + config ──
export * from './dashboard/data';
