/**
 * `@expo/hub-components` — the UI kit of the Expo Hub dashboard. It follows the
 * design of the Expo dashboard website (`universe/server/website`) and uses the
 * same `@expo/styleguide` design tokens. The website does not import this
 * package; its only consumer is `expo-device-hub`.
 *
 * How a component is styled (the full rules are in `expo-device-hub/AGENTS.md`):
 *   - Layout and colors are inline styles that read the typed tokens from
 *     `./theme/tokens`.
 *   - Hover, press and keyboard focus come from the `.hub-pressable` rules in
 *     `./theme/theme.css` ({@link pressableStyle}), not from React state.
 *   - The components ported 1:1 from the website ({@link Dropdown},
 *     {@link Dialog}, the `Select` menu) keep the website's Tailwind classes,
 *     which the consumer's stylesheet must generate (Expo Hub's `global.css`).
 *
 * Import `@expo/hub-components/theme.css` once: it defines the CSS variables
 * and the component rules above.
 */

// ── Components ──
export {
  ActivityIndicator,
  LOADING_LABEL,
  type ActivityIndicatorProps,
} from "./components/ActivityIndicator";
export { Button, type ButtonProps, type ButtonTheme, type ButtonSize } from "./components/Button";
export { ControlButton, type ControlButtonProps } from "./components/ControlButton";
export { DeviceListItem, type DeviceListItemProps } from "./components/DeviceListItem";
export {
  DialogRoot,
  DialogContent,
  DialogTitle,
  DialogContentContainer,
  DialogFooter,
  DialogClose,
} from "./components/Dialog";
export { Dropdown } from "./components/Dropdown";
export { DropdownItem } from "./components/DropdownItem";
export { IconButton, type IconButtonProps } from "./components/IconButton";
export { Logo } from "./components/Logo";
export { ResizeHandle } from "./components/ResizeHandle";
export { Select, type SelectOption, type SelectProps } from "./components/Select";
export { SidebarToggle } from "./components/SidebarToggle";
export { StatusDot, type StatusDotProps } from "./components/StatusDot";
export { Tooltip, type TooltipProps } from "./components/Tooltip";
export { cx } from "./components/cx";
export { PRESSABLE_CLASS, pressableStyle, type PressableColors } from "./components/pressable";
export { usePrefersReducedMotion } from "./components/usePrefersReducedMotion";
export * from "./components/icons";

// ── Design tokens ──
export * from "./theme/tokens";

// ── Dashboard composites ──
// These compose the primitives above into the Expo Hub dashboard layout. They
// read a `DeviceClient` from props and take small helpers from `@expo/hub-client`,
// a peer dependency, so the host's own copy serves both. The device stream is
// injected: `StreamPanel` / `PhoneFrame` take the `DeviceScreen` component +
// `displayScreen` helper as props. The iPhone Duo's 3D preview is the
// `@expo/hub-components/foldable` entry, injected the same way, so only a
// consumer that renders it loads three.js. Screen shapes are `DeviceShape`
// from `@expo/hub-client/shapes`, also injected, so only a consumer that
// passes it bundles the shape table.
export { Sidebar, type SidebarProps } from "./dashboard/Sidebar";
export { InspectorSections, type InspectorSectionsProps } from "./dashboard/InspectorSections";
export { StreamPanel } from "./dashboard/StreamPanel";
export {
  ScreenshotToast,
  ScreenshotToaster,
  useScreenshotToast,
  type ScreenshotToastState,
} from "./dashboard/ScreenshotToast";
export { DeviceTitle, type DeviceTitleProps } from "./dashboard/DeviceTitle";
export { EmptyState } from "./dashboard/EmptyState";
export { DeviceSection, type DeviceSectionProps } from "./dashboard/DeviceSection";
export { CurrentAppSection } from "./dashboard/CurrentAppSection";
export {
  DEVICE_SHAPE_2D_ONLY_DESCRIPTION,
  DeviceOptionsSection,
  NO_DEVICE_SHAPE_DESCRIPTION,
  NO_HARDWARE_KEYBOARD_DESCRIPTION,
  ONSCREEN_KEYBOARD_DESCRIPTION,
  type ScreenShapeOption,
} from "./dashboard/DeviceOptionsSection";
export { ActivityCharts } from "./dashboard/ActivityCharts";
export { AccessibilitySection } from "./dashboard/AccessibilitySection";
export { CameraSection } from "./dashboard/CameraSection";
export { ClipboardSection } from "./dashboard/ClipboardSection";
export {
  ClipboardToast,
  useClipboardToast,
  type ClipboardRequest,
  type ClipboardToastState,
} from "./dashboard/ClipboardToast";
export { LocationSection } from "./dashboard/LocationSection";
export { PermissionsSection } from "./dashboard/PermissionsSection";
export { EventsSection } from "./dashboard/EventsSection";
export { LogsSection } from "./dashboard/LogsSection";
export { CollapsibleSection } from "./dashboard/CollapsibleSection";
export { KeyboardSection } from "./dashboard/KeyboardSection";
export {
  PhoneFrame,
  type FoldPreviewMode,
  type PhoneFrameFoldPreview,
} from "./dashboard/PhoneFrame";
export { MOBILE_CORNER_BUTTON_TOP, MOBILE_SIDEBAR_TOP_INSET } from "./dashboard/cornerButtons";
export { DeviceScreenStatus, deviceScreenLoading } from "./dashboard/DeviceScreenStatus";
export {
  deviceScreenClipPath,
  deviceScreenCornersClipPath,
  type ScreenCornerRadiiCqw,
} from "./dashboard/deviceScreenClipPath";
export { LogControls } from "./dashboard/LogControls";
export { LogList } from "./dashboard/LogList";
export { LogRow } from "./dashboard/LogRow";
export { StreamControls } from "./dashboard/StreamControls";
export {
  FoldSettings,
  MODEL_UNAVAILABLE_DESCRIPTION,
  type FoldPreviewOption,
} from "./dashboard/FoldSettings";
export { FOLD_POSE_OPTIONS, selectedFoldPose } from "./dashboard/foldPoses";
export {
  StreamOptionsSection,
  type StreamOptionsSectionProps,
} from "./dashboard/StreamOptionsSection";
export { RecentDevicesModal, type RecentDevicesModalProps } from "./dashboard/RecentDevicesModal";
export { BootErrorModal, type BootErrorModalProps } from "./dashboard/BootErrorModal";
export {
  ServerConnectionOverlay,
  type ServerConnectionOverlayProps,
} from "./dashboard/ServerConnectionOverlay";

// ── Shared dashboard types + config ──
export * from "./dashboard/data";
