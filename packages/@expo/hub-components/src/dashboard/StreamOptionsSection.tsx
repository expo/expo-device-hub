import { useEffect, useState } from "react";

import {
  resolveDeviceStreamMode,
  type DeviceClient,
  type DeviceGrpcImageMode,
  type DeviceGrpcEncoder,
  type DeviceHttpCodec,
  type DeviceInputSource,
  type DeviceStreamCapabilities,
  type DeviceStreamEncoderSettings,
  type DeviceStreamMode,
  type DeviceStreamSource,
  type DeviceWebRtcCodec,
} from "@expo/hub-client";
import { Select, text, textSize, type SelectOption } from "../primitives";
import { CollapsibleSection } from "./CollapsibleSection";
import { RECORDING_FINISH_REASON, recordingLockText } from "./recording-lock";
import { SectionNote } from "./SectionNote";
import { SidebarRow } from "./SidebarRow";
import { type Platform, type StreamModeAvailability } from "./data";
import { StreamStatistics } from "./StreamStatistics";
import { type SteadyField } from "./useSteadyClient";

type StreamTransport = "http" | "websocket" | "webrtc";

const NOTHING_STALE: ReadonlySet<SteadyField> = new Set();

/** Why a stream setting is locked while the device does not report its stream settings. */
export const STREAM_SETTINGS_UNAVAILABLE_REASON =
  "Stream settings are available once the device reconnects.";

/** Why an encoder setting is locked while the client reports no value for it, or cannot change it. */
export const STREAM_SETTING_UNKNOWN_REASON =
  "This setting is not available for this device at the moment.";

/** Why a codec row is locked on a server that does not offer its transport. */
export const TRANSPORT_UNAVAILABLE_REASON =
  "The server of this device does not offer this transport.";

/** Why the Source row is locked on an Android device that has one capture source. */
export const SINGLE_SOURCE_REASON = "This device has one stream source.";

/**
 * What an Android device renders with: the host's CPU (a software renderer) or
 * a GPU. `unknown` until the Hub answers, and when it cannot read the renderer.
 */
export type DeviceRendering = "unknown" | "cpu" | "gpu";

const RENDERING_LABELS: Record<DeviceRendering, string> = {
  unknown: "Unknown",
  cpu: "CPU",
  gpu: "GPU",
};

export type StreamOptionsSectionProps = {
  /** The client to read from. Pass the client of `useSteadyClient` to keep rows over a reconnect. */
  client: DeviceClient;
  /** The fields of `client` that hold a kept value. Their rows lock. */
  stale?: ReadonlySet<SteadyField>;
  /** Whether the section is initially expanded. */
  defaultOpen?: boolean;
  streamMode?: DeviceStreamMode;
  httpCodec?: DeviceHttpCodec;
  streamModeAvailability?: StreamModeAvailability;
  onStreamModeChange?: (mode: DeviceStreamMode) => void;
  onHttpCodecChange?: (codec: DeviceHttpCodec) => void;
  /**
   * What the device renders with. Omit to hide the row, as for iOS; an Android
   * device shows it from the start, as `unknown`, so the rows do not move.
   */
  rendering?: DeviceRendering;
};

const DEFAULT_SETTINGS: DeviceStreamEncoderSettings = {
  mjpegFps: 30,
  mjpegQuality: 0.7,
  maxDimension: 0,
  h264Bitrate: 6_000_000,
  h264Fps: 30,
};

const DEFAULT_AVAILABILITY: StreamModeAvailability = {
  mjpeg: true,
  h264: true,
  webrtc: true,
};

const DEFAULT_STREAM_CAPABILITIES = {
  modeAvailability: DEFAULT_AVAILABILITY,
  httpCodecs: ["auto", "h264", "mjpeg"],
  webRtcCodecs: ["h264", "vp9", "vp8"],
} as const satisfies DeviceStreamCapabilities;

const STREAM_SOURCE_OPTIONS: ReadonlyArray<SelectOption<DeviceStreamSource>> = [
  { value: "scrcpy", label: "scrcpy" },
  { value: "grpc-screenshot", label: "gRPC" },
  { value: "emulator-capture", label: "Emulator capture" },
];
const GRPC_IMAGE_MODE_OPTIONS: ReadonlyArray<SelectOption<DeviceGrpcImageMode>> = [
  { value: "png", label: "PNG" },
  { value: "mmap", label: "MMAP" },
  { value: "rgb888", label: "RGB888" },
];
const GRPC_ENCODER_OPTIONS: ReadonlyArray<SelectOption<DeviceGrpcEncoder>> = [
  { value: "software", label: "Software" },
  { value: "hardware", label: "Hardware" },
];
const GRPC_INPUT_SOURCE_OPTIONS: ReadonlyArray<SelectOption<DeviceInputSource>> = [
  { value: "scrcpy", label: "scrcpy" },
  { value: "grpc", label: "gRPC" },
];

const HTTP_CODEC_OPTIONS: ReadonlyArray<SelectOption<DeviceHttpCodec>> = [
  { value: "auto", label: "Auto" },
  { value: "h264", label: "H.264" },
  { value: "mjpeg", label: "MJPEG" },
];

const WEBRTC_CODEC_OPTIONS: ReadonlyArray<SelectOption<DeviceWebRtcCodec>> = [
  { value: "h264", label: "H.264" },
  { value: "vp9", label: "VP9" },
  { value: "vp8", label: "VP8" },
];

const MAX_DIMENSION_OPTIONS: SelectOption[] = [
  { value: "0", label: "Full" },
  { value: "1920", label: "1920 px" },
  { value: "1600", label: "1600 px" },
  { value: "1280", label: "1280 px" },
  { value: "960", label: "960 px" },
  { value: "720", label: "720 px" },
];

const FPS_OPTIONS: SelectOption[] = ["60", "30", "20", "15", "10", "5"].map((value) => ({
  value,
  label: `${value} FPS`,
}));

const QUALITY_OPTIONS: SelectOption[] = [
  { value: "0.45", label: "45%" },
  { value: "0.55", label: "55%" },
  { value: "0.7", label: "70%" },
  { value: "0.85", label: "85%" },
  { value: "1", label: "100%" },
];

const BITRATE_OPTIONS: SelectOption[] = [
  { value: "1500000", label: "1.5 Mbps" },
  { value: "3000000", label: "3 Mbps" },
  { value: "6000000", label: "6 Mbps" },
  { value: "10000000", label: "10 Mbps" },
  { value: "16000000", label: "16 Mbps" },
];

const BOTH_PLATFORMS: readonly Platform[] = ["ios", "android"];

/**
 * The runtime encoder settings, in the order of their rows. `platforms` names
 * the platforms whose backend has the setting: a platform has a fixed list of
 * rows, which does not wait for the client to report what it can change.
 * `activeFor` names the codec that reads the setting: the row is disabled
 * while the stream uses another one. A setting without it applies to every
 * stream.
 */
// @ref LLP 0000#steady-inspector — a platform's rows are fixed; a setting that the client does not report is locked
const ENCODER_SETTINGS: ReadonlyArray<{
  key: keyof DeviceStreamEncoderSettings;
  label: string;
  options: SelectOption[];
  /** The label of a current value that is not one of `options`. */
  format: (value: number) => string;
  platforms: readonly Platform[];
  activeFor?: "mjpeg" | "h264";
}> = [
  {
    key: "maxDimension",
    label: "Max size",
    options: MAX_DIMENSION_OPTIONS,
    format: (value) => (value === 0 ? "Full" : `${value} px`),
    platforms: BOTH_PLATFORMS,
  },
  {
    key: "mjpegFps",
    label: "MJPEG FPS",
    options: FPS_OPTIONS,
    format: (value) => `${value} FPS`,
    platforms: ["ios"],
    activeFor: "mjpeg",
  },
  {
    key: "mjpegQuality",
    label: "MJPEG quality",
    options: QUALITY_OPTIONS,
    format: (value) => `${Math.round(value * 100)}%`,
    platforms: ["ios"],
    activeFor: "mjpeg",
  },
  {
    key: "h264Fps",
    label: "Video FPS",
    options: FPS_OPTIONS,
    format: (value) => `${value} FPS`,
    platforms: BOTH_PLATFORMS,
    activeFor: "h264",
  },
  {
    key: "h264Bitrate",
    label: "Video bitrate",
    options: BITRATE_OPTIONS,
    format: (value) => `${value / 1_000_000} Mbps`,
    platforms: BOTH_PLATFORMS,
    activeFor: "h264",
  },
];

function withCurrentValue(
  value: number,
  options: SelectOption[],
  label: (value: number) => string,
) {
  const current = String(value);
  return options.some((option) => option.value === current)
    ? options
    : [{ value: current, label: label(value) }, ...options];
}

/** Viewer transport, backend-supported codecs, and optional runtime encoder controls. */
export function StreamOptionsSection({
  client,
  stale = NOTHING_STALE,
  defaultOpen = false,
  streamMode = "mjpeg",
  httpCodec,
  streamModeAvailability = DEFAULT_AVAILABILITY,
  onStreamModeChange,
  onHttpCodecChange,
  rendering,
}: StreamOptionsSectionProps) {
  const [open, setOpen] = useState(defaultOpen);
  const recordingDisabledReason = recordingLockText(client.recordingLock, RECORDING_FINISH_REASON);
  const recordingControlsLocked = recordingDisabledReason !== undefined;
  const backend: DeviceStreamCapabilities =
    client.streamCapabilities ?? DEFAULT_STREAM_CAPABILITIES;
  const availability: StreamModeAvailability = {
    mjpeg: streamModeAvailability.mjpeg && backend.modeAvailability.mjpeg,
    h264: streamModeAvailability.h264 && backend.modeAvailability.h264,
    webrtc: streamModeAvailability.webrtc && backend.modeAvailability.webrtc,
  };
  const activeStreamMode = resolveDeviceStreamMode(streamMode, availability);
  const primaryTransport: Exclude<StreamTransport, "webrtc"> =
    client.platform === "android" ? "websocket" : "http";
  const primaryTransportLabel = client.platform === "android" ? "WebSocket" : "HTTP";
  const httpCodecOptions = HTTP_CODEC_OPTIONS.filter((option) =>
    backend.httpCodecs.includes(option.value),
  );
  const webRtcCodecOptions = WEBRTC_CODEC_OPTIONS.filter((option) =>
    backend.webRtcCodecs.includes(option.value),
  );
  const settings = client.streamSettings ?? DEFAULT_SETTINGS;
  const settingsCapabilities = client.capabilities.streamSettings;
  const streamSource = client.streamSource;
  const streamSourceError =
    client.streamSourceError ??
    (streamSource?.mode === "grpc-screenshot" ? streamSource.hardwareEncoderError : undefined);
  // A source the server explains but cannot use now stays visible, disabled, with its reason.
  const unavailableSources = STREAM_SOURCE_OPTIONS.flatMap((option) => {
    const reason = streamSource?.unavailableModes?.[option.value];
    return reason && !streamSource?.availableModes.includes(option.value)
      ? [{ option, reason }]
      : [];
  });
  const sourceOptions = STREAM_SOURCE_OPTIONS.flatMap((option) =>
    streamSource?.availableModes.includes(option.value)
      ? [option]
      : unavailableSources.some((entry) => entry.option.value === option.value)
        ? [{ ...option, disabled: true }]
        : [],
  );
  const inputSourceOptions = GRPC_INPUT_SOURCE_OPTIONS.filter((option) =>
    streamSource?.availableInputSources.includes(option.value),
  );
  const settingsKnown = client.streamSettings !== null;
  // A kept copy of the settings shows their last values, but only live settings can change.
  const settingsReady = settingsKnown && !stale.has("streamSettings");
  const settingsDisabled =
    recordingControlsLocked || !settingsReady || client.streamSettingsPending;
  const settingsDisabledReason =
    recordingDisabledReason ??
    (stale.has("streamSettings") ? STREAM_SETTINGS_UNAVAILABLE_REASON : undefined);
  const sourceDisabled =
    recordingControlsLocked || client.streamSourcePending || stale.has("streamSource");
  const sourceDisabledReason =
    recordingDisabledReason ??
    (stale.has("streamSource") ? STREAM_SETTINGS_UNAVAILABLE_REASON : undefined);
  const transport: StreamTransport = activeStreamMode === "webrtc" ? "webrtc" : primaryTransport;
  const setStreamStatsEnabled = client.setStreamStatsEnabled;
  const httpAvailable = availability.mjpeg || availability.h264;
  const transportOptions: ReadonlyArray<SelectOption<StreamTransport>> = [
    { value: primaryTransport, label: primaryTransportLabel, disabled: !httpAvailable },
    { value: "webrtc", label: "WebRTC", disabled: !availability.webrtc },
  ];

  useEffect(() => {
    setStreamStatsEnabled(open && transport === "webrtc");
    return () => setStreamStatsEnabled(false);
  }, [open, setStreamStatsEnabled, transport]);

  function httpCodecAvailable(codec: DeviceHttpCodec): boolean {
    if (codec === "h264") return availability.h264;
    if (codec === "mjpeg") return availability.mjpeg;
    return httpAvailable;
  }

  const requestedHttpCodec: DeviceHttpCodec =
    httpCodec ??
    (activeStreamMode === "mjpeg" ? "mjpeg" : activeStreamMode === "h264" ? "h264" : "auto");
  const modeHttpCodec =
    activeStreamMode === "mjpeg" || activeStreamMode === "h264" ? activeStreamMode : null;
  const fallbackHttpCodec =
    (modeHttpCodec &&
    backend.httpCodecs.includes(modeHttpCodec) &&
    httpCodecAvailable(modeHttpCodec)
      ? modeHttpCodec
      : undefined) ?? httpCodecOptions.find((option) => httpCodecAvailable(option.value))?.value;
  const selectedHttpCodec: DeviceHttpCodec =
    backend.httpCodecs.includes(requestedHttpCodec) && httpCodecAvailable(requestedHttpCodec)
      ? requestedHttpCodec
      : (fallbackHttpCodec ?? requestedHttpCodec);
  const selectedWebRtcCodec = backend.webRtcCodecs.includes(client.webRtcCodec)
    ? client.webRtcCodec
    : (webRtcCodecOptions[0]?.value ?? client.webRtcCodec);
  const h264Active = transport === "webrtc" || (availability.h264 && selectedHttpCodec !== "mjpeg");

  function httpMode(codec: DeviceHttpCodec): DeviceStreamMode {
    if (codec === "mjpeg") return "mjpeg";
    if (codec === "h264") return availability.h264 ? "h264" : "mjpeg";
    return availability.h264 ? "h264" : "mjpeg";
  }

  function changeTransport(nextTransport: StreamTransport) {
    onStreamModeChange?.(nextTransport === "webrtc" ? "webrtc" : httpMode(selectedHttpCodec));
  }

  function changeHttpCodec(codec: DeviceHttpCodec) {
    onHttpCodecChange?.(codec);
    if (transport !== "webrtc") onStreamModeChange?.(httpMode(codec));
  }

  function patchSetting<Key extends keyof DeviceStreamEncoderSettings>(
    key: Key,
    value: DeviceStreamEncoderSettings[Key],
  ) {
    if (!settingsDisabled) client.updateStreamSettings({ [key]: value });
  }

  const restricted =
    (backend.modeAvailability.h264 && !streamModeAvailability.h264) ||
    (backend.modeAvailability.webrtc && !streamModeAvailability.webrtc);
  const hostWebRtcDisabled = client.platform === "android" && !backend.modeAvailability.webrtc;

  return (
    <CollapsibleSection title="Stream options" open={open} onOpenChange={setOpen}>
      {rendering && (
        <SidebarRow label="Rendering">
          <span aria-live="polite" style={{ ...textSize.sm, flexShrink: 0, color: text.secondary }}>
            {RENDERING_LABELS[rendering]}
          </span>
        </SidebarRow>
      )}
      {client.platform === "android" && (
        // Only Android has capture sources. The row stays for a device with one source, and
        // while the client has not reported its sources: it is then locked.
        <>
          <SidebarRow label="Source">
            <Select
              ariaLabel="Stream source"
              options={sourceOptions}
              value={(streamSource?.mode ?? "") as DeviceStreamSource}
              disabled={sourceDisabled || sourceOptions.length < 2}
              disabledReason={
                sourceDisabledReason ??
                (sourceOptions.length >= 2
                  ? undefined
                  : streamSource
                    ? SINGLE_SOURCE_REASON
                    : STREAM_SETTING_UNKNOWN_REASON)
              }
              onChange={client.setStreamSource}
            />
          </SidebarRow>
          {unavailableSources.map(({ option, reason }) => (
            <SectionNote key={option.value}>{`${option.label}: ${reason}`}</SectionNote>
          ))}
        </>
      )}
      {streamSource?.mode === "grpc-screenshot" && (
        <>
          {inputSourceOptions.length > 1 && (
            <SidebarRow label="Input">
              <Select
                ariaLabel="Input source"
                options={inputSourceOptions}
                value={streamSource.inputSource}
                disabled={sourceDisabled}
                disabledReason={sourceDisabledReason}
                onChange={client.setGrpcInputSource}
              />
            </SidebarRow>
          )}
          <SidebarRow label="gRPC frames">
            <Select
              ariaLabel="gRPC image mode"
              options={GRPC_IMAGE_MODE_OPTIONS}
              value={streamSource.grpcImageMode}
              disabled={sourceDisabled}
              disabledReason={sourceDisabledReason}
              onChange={client.setGrpcImageMode}
            />
          </SidebarRow>
          <SidebarRow label="Encoder">
            <Select
              ariaLabel="gRPC encoder"
              options={GRPC_ENCODER_OPTIONS.map((option) => ({
                ...option,
                disabled: !streamSource.availableEncoders.includes(option.value),
              }))}
              value={streamSource.encoder}
              disabled={sourceDisabled}
              disabledReason={sourceDisabledReason}
              onChange={client.setGrpcEncoder}
            />
          </SidebarRow>
          {streamSource.encoderName && (
            <SectionNote>{`Active encoder: ${streamSource.encoderName}`}</SectionNote>
          )}
        </>
      )}
      {streamSource && streamSourceError && (
        <SectionNote role="alert">{streamSourceError}</SectionNote>
      )}
      <SidebarRow label="Transport">
        <Select
          ariaLabel="Stream transport"
          options={transportOptions}
          value={transport}
          disabled={!onStreamModeChange}
          onChange={changeTransport}
        />
      </SidebarRow>
      {/* Both codec rows stay. A server that is locked to one transport has no codecs for the
          other one, and that row is then locked. */}
      <SidebarRow label={`${primaryTransportLabel} codec`}>
        <Select
          ariaLabel={`${primaryTransportLabel} codec`}
          options={httpCodecOptions.map((option) => ({
            ...option,
            disabled: !httpCodecAvailable(option.value),
          }))}
          value={(httpCodecOptions.length > 0 ? selectedHttpCodec : "") as DeviceHttpCodec}
          disabled={transport === "webrtc" || !onHttpCodecChange || httpCodecOptions.length === 0}
          disabledReason={httpCodecOptions.length === 0 ? TRANSPORT_UNAVAILABLE_REASON : undefined}
          onChange={changeHttpCodec}
        />
      </SidebarRow>
      <SidebarRow label="WebRTC codec">
        <Select
          ariaLabel="WebRTC codec"
          options={webRtcCodecOptions}
          value={(webRtcCodecOptions.length > 0 ? selectedWebRtcCodec : "") as DeviceWebRtcCodec}
          disabled={
            transport !== "webrtc" || !availability.webrtc || webRtcCodecOptions.length === 0
          }
          disabledReason={
            webRtcCodecOptions.length === 0 ? TRANSPORT_UNAVAILABLE_REASON : undefined
          }
          onChange={(codec: DeviceWebRtcCodec) => client.setWebRtcCodec(codec)}
        />
      </SidebarRow>
      {restricted && (
        <SectionNote>
          {client.platform === "android" || !backend.modeAvailability.mjpeg
            ? "WebRTC requires localhost or HTTPS."
            : "H.264 and WebRTC require localhost or HTTPS. MJPEG remains available on insecure HTTP."}
        </SectionNote>
      )}
      {hostWebRtcDisabled && (
        <SectionNote>
          Start the standalone server with --transport webrtc to enable WebRTC.
        </SectionNote>
      )}
      {ENCODER_SETTINGS.filter(({ platforms }) => platforms.includes(client.platform)).map(
        ({ key, label, options, format, activeFor }) => {
          // The client reports what its backend can change only after it connects, and a
          // server that is locked to one transport reports nothing.
          const supported = !!settingsCapabilities && settingsCapabilities[key];
          return (
            <SidebarRow key={key} label={label}>
              <Select
                ariaLabel={label}
                // A value that is not known shows the placeholder of the select.
                value={settingsKnown ? String(settings[key]) : ""}
                options={withCurrentValue(settings[key], options, format)}
                disabled={
                  settingsDisabled ||
                  !supported ||
                  (activeFor === "mjpeg" && transport !== "http") ||
                  (activeFor === "h264" && !h264Active)
                }
                disabledReason={
                  settingsDisabledReason ??
                  (supported && settingsKnown ? undefined : STREAM_SETTING_UNKNOWN_REASON)
                }
                onChange={(value) => patchSetting(key, Number(value))}
              />
            </SidebarRow>
          );
        },
      )}
      {transport === "webrtc" && (
        <StreamStatistics stats={client.streamStats} platform={client.platform} />
      )}
    </CollapsibleSection>
  );
}
