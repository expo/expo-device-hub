import { type DeviceClient, type DeviceHttpCodec, type DeviceStreamMode } from "@expo/hub-client";
import { type ReactNode, useState } from "react";

import { AccessibilitySection } from "./AccessibilitySection";
import { CameraSection } from "./CameraSection";
import { ClipboardSection } from "./ClipboardSection";
import { type ClipboardRequest } from "./ClipboardToast";
import { PermissionsSection } from "./PermissionsSection";
import { CollapsibleSection } from "./CollapsibleSection";
import { CurrentAppSection } from "./CurrentAppSection";
import { DeviceOptionsSection } from "./DeviceOptionsSection";
import { type GpuWarningInfo } from "./GpuWarning";
import { type FoldPreviewOption } from "./FoldSettings";
import { EventsSection } from "./EventsSection";
import { LocationSection } from "./LocationSection";
import { LogsSection } from "./LogsSection";
import { SectionNote } from "./SectionNote";
import { StreamOptionsSection } from "./StreamOptionsSection";
import { type Device, type Platform, type StreamModeAvailability } from "./data";
import { type SteadyField, useSteadyClient } from "./useSteadyClient";

const NOTHING_STALE: ReadonlySet<SteadyField> = new Set();

export type InspectorSectionsProps = {
  /** Active device connection — feeds the inspector sections. */
  client?: DeviceClient;
  /** Selected device metadata used by viewer-local options. */
  device?: Device;
  /**
   * The selected emulator renders on the CPU although the host has a usable
   * GPU. Shown in Device options; ignored for simulators and physical devices.
   */
  gpuWarning?: GpuWarningInfo | null;
  /** Viewer-local preference: clip the screen to its device shape, or show the plain video rectangle. */
  showScreenShape?: boolean;
  /** Change the viewer-local screen shape preference. */
  onShowScreenShapeChange?: (show: boolean) => void;
  /**
   * Whether the selected device has a known screen shape, which the consumer
   * looks up in `@expo/hub-client/shapes`. Without one, the option is disabled.
   */
  screenShapeAvailable?: boolean;
  /** Viewer-selected simulator stream mode. */
  streamMode?: DeviceStreamMode;
  /** Viewer-selected HTTP codec. */
  httpCodec?: DeviceHttpCodec;
  /** Which modes the current browser context can use. */
  streamModeAvailability?: StreamModeAvailability;
  /** Change the viewer-local stream mode. */
  onStreamModeChange?: (mode: DeviceStreamMode) => void;
  /** Change the viewer-local HTTP codec. */
  onHttpCodecChange?: (codec: DeviceHttpCodec) => void;
  /** Shut the selected device down on the host. */
  onShutdown?: () => void;
  /** Remove/delete the selected device on the host. Ignored for physical devices. */
  onRemove?: () => void;
  /** A toolbar Paste or Copy that the browser clipboard stopped, for the Clipboard section to finish. */
  clipboardRequest?: ClipboardRequest | null;
  /** The Clipboard section took over `clipboardRequest`. */
  onClipboardRequestHandled?: () => void;
  /** Viewer-local 2D/3D choices for an iPhone Duo. */
  foldPreview?: FoldPreviewOption;
};

// @ref LLP 0000#steady-inspector — a platform's sections are fixed, so they do not come and go with the connection
/** The sections that every device of a platform has, also before the device reports its capabilities. */
const PLATFORM_SECTIONS: Record<Platform, ReadonlySet<CapabilitySection>> = {
  ios: new Set(["accessibility", "location", "clipboard", "events"]),
  android: new Set(["camera", "accessibility", "location", "permissions", "events"]),
};

type CapabilitySection =
  | "camera"
  | "accessibility"
  | "location"
  | "permissions"
  | "clipboard"
  | "events";

const SECTION_TITLES: Record<CapabilitySection, string> = {
  camera: "Camera",
  accessibility: "Accessibility",
  location: "Location",
  permissions: "Permissions",
  clipboard: "Clipboard",
  events: "Events",
};

/** What a section says while its device does not offer the capability. */
export const SECTION_UNAVAILABLE_NOTE = "Not available for this device at the moment.";

/** A section of a capability that the device does not offer now. It keeps the section's place. */
function UnavailableSection({ title }: { title: string }) {
  const [open, setOpen] = useState(false);
  return (
    <CollapsibleSection title={title} open={open} onOpenChange={setOpen}>
      <SectionNote>{SECTION_UNAVAILABLE_NOTE}</SectionNote>
    </CollapsibleSection>
  );
}

/**
 * The inspector for the selected device: current app, device and stream options,
 * and the other capability sections, ending with the logs. The dashboard's left
 * sidebar embeds it below the device lists.
 *
 * Its sections do not come and go while the device connects or reconnects. A
 * selected device always has Device options, Stream options, and the sections
 * of its platform. The inspector reads the client through
 * {@link useSteadyClient}, so a section keeps its rows and their last values
 * while the client reports none, and locks them instead.
 */
export function InspectorSections({
  client: liveClient,
  device,
  gpuWarning,
  showScreenShape = true,
  onShowScreenShapeChange,
  screenShapeAvailable = false,
  streamMode,
  httpCodec,
  streamModeAvailability,
  onStreamModeChange,
  onHttpCodecChange,
  onShutdown,
  onRemove,
  clipboardRequest,
  onClipboardRequestHandled,
  foldPreview,
}: InspectorSectionsProps) {
  const steady = useSteadyClient(liveClient, device);
  const client = steady?.client;
  const stale = steady?.stale ?? NOTHING_STALE;
  // The device list knows the platform at once; the client only after it connects.
  const platform = device?.platform ?? client?.platform;
  const screenShape = device
    ? {
        available: screenShapeAvailable,
        visible: showScreenShape,
        onVisibleChange: onShowScreenShapeChange ?? (() => {}),
      }
    : undefined;
  // Physical devices cannot be deleted from the host.
  const onRemoveDevice = device?.physical ? undefined : onRemove;
  const emulatorGpuWarning =
    device?.platform === "android" && !device.physical ? gpuWarning : undefined;

  // A section shows for a capability of the device's platform, or one that the device reported.
  const section = (name: CapabilitySection, content: (client: DeviceClient) => ReactNode) => {
    if (!client) return null;
    if (client.capabilities[name]) return content(client);
    if (!device || !PLATFORM_SECTIONS[device.platform].has(name)) return null;
    return <UnavailableSection key={name} title={SECTION_TITLES[name]} />;
  };

  return (
    <>
      <CurrentAppSection client={client} />
      {(device ||
        client?.capabilities.deviceSettings ||
        client?.capabilities.fold ||
        client?.platform === "android" ||
        (client && (onShutdown || onRemoveDevice))) && (
        <DeviceOptionsSection
          client={client}
          platform={platform}
          stale={stale}
          gpuWarning={emulatorGpuWarning}
          screenShape={screenShape}
          foldPreview={foldPreview}
          onShutdown={onShutdown}
          onRemove={onRemoveDevice}
        />
      )}
      {client && (device || client.streamCapabilities) && (
        <StreamOptionsSection
          client={client}
          stale={stale}
          streamMode={streamMode}
          httpCodec={httpCodec}
          streamModeAvailability={streamModeAvailability}
          onStreamModeChange={onStreamModeChange}
          onHttpCodecChange={onHttpCodecChange}
        />
      )}
      {section("camera", (client) => (
        <CameraSection client={client} />
      ))}
      {section("accessibility", (client) => (
        <AccessibilitySection client={client} />
      ))}
      {section("location", (client) => (
        <LocationSection key={device?.id} client={client} />
      ))}
      {section("permissions", (client) => (
        <PermissionsSection client={client} />
      ))}
      {section("clipboard", (client) => (
        <ClipboardSection
          key={`clipboard:${device?.id}`}
          client={client}
          request={clipboardRequest}
          onRequestHandled={onClipboardRequestHandled}
        />
      ))}
      {section("events", (client) => (
        <EventsSection client={client} />
      ))}
      <LogsSection client={client} />
    </>
  );
}
