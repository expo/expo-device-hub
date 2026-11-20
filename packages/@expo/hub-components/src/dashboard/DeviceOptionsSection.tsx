import { useEffect, useId, useState } from "react";

import { type DeviceClient, type DeviceOrientation, type DeviceSettingKey } from "@expo/hub-client";
import { Select, type SelectOption } from "../primitives";
import { CollapsibleSection } from "./CollapsibleSection";
import { type Platform } from "./data";
import { recordingLockText } from "./recording-lock";
import { rotateNotAvailableText, rotationUnavailableText } from "./rotation-availability";
import { FoldSettings, ModelPreviewSettings, type FoldPreviewOption } from "./FoldSettings";
import { KeyboardSection } from "./KeyboardSection";
import { SidebarActionButton } from "./SidebarActionButton";
import { SidebarRow } from "./SidebarRow";
import { SidebarSwitch } from "./SidebarSwitch";
import { type SteadyField } from "./useSteadyClient";

const APPEARANCE_OPTIONS: SelectOption[] = [
  { value: "light", label: "Light" },
  { value: "dark", label: "Dark" },
];

const NETWORK_OPTIONS: SelectOption[] = [
  { value: "on", label: "On" },
  { value: "off", label: "Off" },
];

const LIQUID_GLASS_OPTIONS: SelectOption[] = [
  { value: "clear", label: "Clear" },
  { value: "tinted", label: "Tinted" },
];

const COLOR_FILTER_OPTIONS: SelectOption[] = [
  { value: "none", label: "None" },
  { value: "grayscale", label: "Grayscale" },
  { value: "red-green", label: "Red-green" },
  { value: "green-red", label: "Green-red" },
  { value: "blue-yellow", label: "Blue-yellow" },
];

const TEXT_SIZE_OPTIONS: SelectOption[] = [
  { value: "extra-small", label: "XS" },
  { value: "small", label: "S" },
  { value: "medium", label: "M" },
  { value: "large", label: "L" },
  { value: "extra-large", label: "XL" },
  { value: "extra-extra-large", label: "2XL" },
  { value: "extra-extra-extra-large", label: "3XL" },
];

const ANDROID_TEXT_SIZE_OPTIONS: SelectOption[] = [
  { value: "small", label: "S" },
  { value: "medium", label: "M" },
  { value: "large", label: "L" },
  { value: "extra-large", label: "XL" },
];

const ANDROID_DISPLAY_SIZE_OPTIONS: SelectOption[] = [
  { value: "small", label: "S" },
  { value: "medium", label: "M" },
  { value: "large", label: "L" },
  { value: "extra-large", label: "XL" },
];

/**
 * The settings with a select and no description, in the order of their rows.
 * A setting without a `platform` exists on both; `androidOptions` replaces the
 * options on Android.
 */
const SELECT_SETTINGS: ReadonlyArray<{
  key: DeviceSettingKey;
  label: string;
  platform?: Platform;
  options: SelectOption[];
  androidOptions?: SelectOption[];
}> = [
  { key: "appearance", label: "Appearance", options: APPEARANCE_OPTIONS },
  { key: "liquid-glass", label: "Liquid glass", platform: "ios", options: LIQUID_GLASS_OPTIONS },
  { key: "color-filter", label: "Color filter", platform: "ios", options: COLOR_FILTER_OPTIONS },
  { key: "network", label: "Network", platform: "android", options: NETWORK_OPTIONS },
  {
    key: "text-size",
    label: "Text size",
    options: TEXT_SIZE_OPTIONS,
    androidOptions: ANDROID_TEXT_SIZE_OPTIONS,
  },
];

const ORIENTATION_OPTIONS: ReadonlyArray<SelectOption<DeviceOrientation>> = [
  { value: "portrait", label: "Portrait" },
  { value: "landscape_left", label: "Landscape left" },
  { value: "landscape_right", label: "Landscape right" },
  { value: "portrait_upside_down", label: "Upside down" },
];

/**
 * The settings with a switch, in the order of their rows. A setting without a
 * `platform` exists on both platforms.
 */
const SWITCH_SETTINGS: ReadonlyArray<{
  key: DeviceSettingKey;
  label: string;
  platform?: Platform;
}> = [
  { key: "reduce-motion", label: "Reduce motion" },
  { key: "bold-text", label: "Bold text", platform: "android" },
  { key: "increase-contrast", label: "Increase contrast" },
  { key: "show-borders", label: "Show borders", platform: "ios" },
  { key: "reduce-transparency", label: "Reduce transparency", platform: "ios" },
  { key: "voiceover", label: "VoiceOver", platform: "ios" },
];

const EMPTY_PENDING_SETTINGS: ReadonlySet<DeviceSettingKey> = new Set();
const NOTHING_STALE: ReadonlySet<SteadyField> = new Set();

/** Why a setting is locked while the Hub cannot read the device's settings. */
export const SETTINGS_UNAVAILABLE_REASON =
  "Settings are temporarily unavailable. The Hub tries again automatically.";

/** Why a setting is locked on a device that does not have it. */
export const SETTING_UNSUPPORTED_REASON = "Not available on this device.";

/** Why Orientation is locked while the device offers no poses or has not reported its pose. */
export const ORIENTATION_UNKNOWN_REASON =
  "Orientation is not available for this device at the moment.";

/** Why the fold controls are locked while the device does not report its fold. */
export const FOLD_UNKNOWN_REASON = "Fold controls are available once the device reconnects.";

export const NO_DEVICE_SHAPE_DESCRIPTION = "No device shape for selected device.";

export const DEVICE_SHAPE_2D_ONLY_DESCRIPTION = "Applies to the 2D view only.";

export const NO_HARDWARE_KEYBOARD_DESCRIPTION =
  "This device has no hardware keyboard, so the on-screen keyboard always shows.";

export const ONSCREEN_KEYBOARD_DESCRIPTION =
  "Keeps the on-screen keyboard visible while a hardware keyboard is attached. A device with no hardware keyboard always shows it.";

/** The viewer-local screen shape option: the device shape, or the whole video rectangle. */
export type ScreenShapeOption = {
  /** Whether the selected device has a known shape. Without one, the option is off and disabled. */
  available: boolean;
  visible: boolean;
  onVisibleChange: (visible: boolean) => void;
};

/**
 * Device-wide appearance, connectivity, and accessibility settings, plus iOS
 * keyboard controls, the viewer-local screen shape option, and device-level
 * actions (Android Back and Recents keys, shutting down or removing the device).
 * A foldable leads with its fold controls, as serve-sim's settings do for the iPhone Duo.
 *
 * The rows of a platform are always there. A row does not come or go while the
 * device connects, reconnects, or reads its settings: it keeps its last value
 * and locks, and a locked row says why when it has a reason.
 */
export function DeviceOptionsSection({
  client,
  platform = client?.platform,
  stale = NOTHING_STALE,
  screenShape,
  foldPreview,
  onShutdown,
  onRemove,
}: {
  /** The client to read from. Pass the client of `useSteadyClient` to keep rows over a reconnect. */
  client?: DeviceClient;
  /** The platform of the selected device. It picks the rows; the client knows it only once it connects. */
  platform?: Platform;
  /** The fields of `client` that hold a kept value. Their rows lock. */
  stale?: ReadonlySet<SteadyField>;
  screenShape?: ScreenShapeOption;
  /** Viewer-local 2D/3D choices for a device that the 3D model can show. */
  foldPreview?: FoldPreviewOption;
  /** Shut the device down on the host. */
  onShutdown?: () => void;
  /** Remove/delete the device on the host. Omit for physical devices. */
  onRemove?: () => void;
}) {
  const [open, setOpen] = useState(true);
  // Like serve-sim's settings, a failed fold command opens the section to show its error.
  const foldError = client?.fold?.error ?? null;
  useEffect(() => {
    if (foldError) setOpen(true);
  }, [foldError]);
  const recordingDisabledReason = recordingLockText(client?.recordingLock);
  const recordingControlsLocked = recordingDisabledReason !== undefined;
  // A recording that follows folds leaves the fold controls on; see `DeviceFold.unavailable`.
  const foldDisabledReason = stale.has("fold")
    ? FOLD_UNKNOWN_REASON
    : recordingLockText(client?.fold?.unavailable);
  const shapeDescriptionId = useId();
  // The 3D model draws its own device, so the screen shape applies to the 2D
  // view only. The 3D view shows while 3D is chosen and its model loads.
  // @ref LLP 0017#hub-dashboard — the shape option applies to the 2D view only
  const shapeIn3D = foldPreview?.mode === "3d";
  const shapeDescription = !screenShape?.available
    ? NO_DEVICE_SHAPE_DESCRIPTION
    : shapeIn3D
      ? DEVICE_SHAPE_2D_ONLY_DESCRIPTION
      : undefined;
  const displaySizeDescriptionId = useId();
  const onscreenKeyboardDescriptionId = useId();
  const orientationErrorId = useId();
  const settings = client?.deviceSettings ?? null;
  const settingsNotAvailable = client?.capabilities.deviceSettings
    ? undefined
    : client?.unavailableReasons?.deviceSettings;
  // The Hub can read and write the settings now. A kept copy of them is not enough.
  const settingsLive =
    !!client?.capabilities.deviceSettings &&
    client.deviceSettingsStatus === "ready" &&
    !stale.has("deviceSettings");
  const settingsLoading =
    client?.deviceSettingsStatus === "loading" || client?.deviceSettingsStatus === "idle";
  const noHardwareKeyboard = client?.hardwareKeyboardConnected === false;
  const pending = client?.deviceSettingsPending ?? EMPTY_PENDING_SETTINGS;
  const displayWidthDp = client?.displayWidthDp ?? null;

  /** Whether a setting has a row. Without a platform, only the settings of both platforms do. */
  function shown(setting: { platform?: Platform }) {
    return setting.platform === undefined || setting.platform === platform;
  }

  /** The value that the device reported, or undefined when it has none for the setting. */
  function value(key: DeviceSettingKey): string | undefined {
    const reported = settings?.[key];
    return reported === "unsupported" ? undefined : reported;
  }

  // @ref LLP 0000#steady-inspector — an unsupported setting keeps its row and locks; the website hides it
  /** Why the setting's control is locked, or undefined when it is locked without a reason or free. */
  function lockReason(key: DeviceSettingKey): string | undefined {
    if (settingsNotAvailable) return settingsNotAvailable;
    if (settingsLoading) return undefined;
    if (!settingsLive) return SETTINGS_UNAVAILABLE_REASON;
    return value(key) === undefined ? SETTING_UNSUPPORTED_REASON : undefined;
  }

  function disabled(key: DeviceSettingKey) {
    return !settingsLive || value(key) === undefined || pending.has(key);
  }

  function setValue(key: DeviceSettingKey, nextValue: string) {
    if (!disabled(key)) client?.setDeviceSetting(key, nextValue);
  }

  const orientationCapabilities = client?.capabilities.orientation;
  const orientationOptions = orientationCapabilities
    ? ORIENTATION_OPTIONS.filter(({ value }) =>
        orientationCapabilities.orientations.includes(value),
      )
    : [];
  // The select shows the last pick at once, then the device's report. Rotate works before that.
  const currentOrientation = client?.orientation ?? null;
  const rotationUnavailable = rotationUnavailableText(client?.orientationUnavailable ?? null);
  const rotateNotAvailable = client ? rotateNotAvailableText(client) : undefined;
  const orientationLockReason =
    rotateNotAvailable ??
    (orientationOptions.length === 0 || currentOrientation === null || stale.has("orientation")
      ? ORIENTATION_UNKNOWN_REASON
      : rotationUnavailable);

  return (
    <CollapsibleSection title="Device options" open={open} onOpenChange={setOpen}>
      {client?.fold && client.capabilities.fold ? (
        <FoldSettings
          fold={client.fold}
          controls={client.capabilities.fold}
          disabledReason={foldDisabledReason}
          preview={foldPreview}
          separateDisplays={!!client.displays}
        />
      ) : (
        foldPreview && (
          <div role="group" aria-label="3D preview">
            <ModelPreviewSettings preview={foldPreview} />
          </div>
        )
      )}

      {SELECT_SETTINGS.filter(shown).map((setting) => (
        <SidebarRow key={setting.key} label={setting.label}>
          <Select
            ariaLabel={setting.label}
            options={
              platform === "android" && setting.androidOptions
                ? setting.androidOptions
                : setting.options
            }
            value={value(setting.key) ?? ""}
            disabled={disabled(setting.key)}
            disabledReason={lockReason(setting.key)}
            onChange={(nextValue) => setValue(setting.key, nextValue)}
          />
        </SidebarRow>
      ))}

      {platform === "android" && (
        <SidebarRow
          label="Display size"
          description={displayWidthDp === null ? undefined : `sw${displayWidthDp}dp`}
          descriptionId={displayWidthDp === null ? undefined : displaySizeDescriptionId}
        >
          <Select
            ariaLabel="Display size"
            ariaDescribedBy={displayWidthDp === null ? undefined : displaySizeDescriptionId}
            options={ANDROID_DISPLAY_SIZE_OPTIONS}
            value={value("display-size") ?? ""}
            disabled={disabled("display-size")}
            disabledReason={lockReason("display-size")}
            onChange={(nextValue) => setValue("display-size", nextValue)}
          />
        </SidebarRow>
      )}

      {SWITCH_SETTINGS.filter(shown).map(({ key, label }) => (
        <SidebarRow key={key} label={label}>
          <SidebarSwitch
            checked={value(key) === "on"}
            disabled={disabled(key)}
            disabledReason={lockReason(key)}
            label={label}
            onChange={(checked) => setValue(key, checked ? "on" : "off")}
          />
        </SidebarRow>
      ))}

      {platform === "android" && (
        <SidebarRow
          label="Force on-screen keyboard"
          description={
            noHardwareKeyboard ? NO_HARDWARE_KEYBOARD_DESCRIPTION : ONSCREEN_KEYBOARD_DESCRIPTION
          }
          descriptionId={onscreenKeyboardDescriptionId}
        >
          <SidebarSwitch
            checked={value("onscreen-keyboard") === "on"}
            disabled={noHardwareKeyboard || disabled("onscreen-keyboard")}
            disabledReason={noHardwareKeyboard ? undefined : lockReason("onscreen-keyboard")}
            label="Force on-screen keyboard"
            descriptionId={onscreenKeyboardDescriptionId}
            onChange={(checked) => setValue("onscreen-keyboard", checked ? "on" : "off")}
          />
        </SidebarRow>
      )}

      {client && platform !== undefined && (
        <SidebarRow
          label="Orientation"
          description={client.orientationError ?? undefined}
          descriptionId={client.orientationError ? orientationErrorId : undefined}
        >
          <Select
            ariaLabel="Orientation"
            ariaDescribedBy={client.orientationError ? orientationErrorId : undefined}
            options={rotateNotAvailable ? ORIENTATION_OPTIONS : orientationOptions}
            value={currentOrientation ?? ""}
            disabled={orientationLockReason !== undefined}
            disabledReason={orientationLockReason}
            onChange={(orientation) => {
              if (orientation !== "") client.setOrientation(orientation);
            }}
          />
        </SidebarRow>
      )}

      {screenShape && (
        <SidebarRow
          label="Show device shape"
          description={shapeDescription}
          descriptionId={shapeDescription ? shapeDescriptionId : undefined}
        >
          <SidebarSwitch
            checked={screenShape.available && screenShape.visible}
            disabled={!screenShape.available || shapeIn3D}
            label="Show device shape"
            descriptionId={shapeDescription ? shapeDescriptionId : undefined}
            onChange={screenShape.onVisibleChange}
          />
        </SidebarRow>
      )}

      {client && platform === "ios" && (
        <KeyboardSection client={client} disabledReason={settingsNotAvailable} />
      )}

      {client && platform === "android" && (
        <>
          <SidebarRow label="Back button">
            <SidebarActionButton onClick={() => client.pressButton("back")}>
              Press
            </SidebarActionButton>
          </SidebarRow>
          <SidebarRow label="Recents button">
            <SidebarActionButton onClick={() => client.pressButton("recents")}>
              Press
            </SidebarActionButton>
          </SidebarRow>
          <SidebarRow label="Dismiss on-screen keyboard">
            <SidebarActionButton onClick={() => client.pressButton("hideKeyboard")}>
              Press
            </SidebarActionButton>
          </SidebarRow>
        </>
      )}

      {client && onShutdown && (
        <SidebarRow label="Shut down device">
          <SidebarActionButton
            disabled={recordingControlsLocked}
            disabledReason={recordingDisabledReason}
            onClick={onShutdown}
          >
            Shut down
          </SidebarActionButton>
        </SidebarRow>
      )}

      {client && onRemove && (
        <SidebarRow label="Remove device">
          <SidebarActionButton
            destructive
            disabled={recordingControlsLocked}
            disabledReason={recordingDisabledReason}
            onClick={onRemove}
          >
            Remove
          </SidebarActionButton>
        </SidebarRow>
      )}
    </CollapsibleSection>
  );
}
