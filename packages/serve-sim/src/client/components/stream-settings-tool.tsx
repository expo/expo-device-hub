import { useState } from "react";
import { SlidersHorizontal, Video } from "lucide-react";
import { CollapsibleSection } from "./collapsible-section";
import { TriangleAlert } from "lucide-react";
import { useSenderStats } from "../hooks/use-sender-stats";
import { useStreamStats } from "../hooks/use-stream-stats";
import { StreamStatsDownload, StreamStatsSection, describeFaults, summariseStream } from "./stream-stats-tool";
import { SettingRow, SettingSelect } from "./simulator-settings-tool";
import { streamFpsOptions } from "../utils/stream-fps-options";
import type {
  HttpStreamCodec,
  StreamControlSettings,
  StreamEncoderSettings,
  StreamPlaybackSettings,
  WebRtcStreamCodec,
} from "../../stream-settings";

type StreamTransport = StreamControlSettings["transport"];

const TRANSPORT_OPTIONS = [
  { value: "http", label: "HTTP" },
  { value: "webrtc", label: "WebRTC" },
];
const LOCKED_WEBRTC_TRANSPORT_OPTIONS = [{ value: "webrtc", label: "WebRTC" }];
const HTTP_CODEC_OPTIONS = [
  { value: "auto", label: "Auto" },
  { value: "h264", label: "H.264" },
  { value: "mjpeg", label: "MJPEG" },
];
const WEBRTC_CODEC_OPTIONS = [
  { value: "h264", label: "H.264" },
  { value: "vp9", label: "VP9" },
  { value: "vp8", label: "VP8" },
];
const MAX_DIMENSION_OPTIONS = [
  { value: "0", label: "Full" },
  { value: "1920", label: "1920" },
  { value: "1600", label: "1600" },
  { value: "1280", label: "1280" },
  { value: "960", label: "960" },
  { value: "720", label: "720" },
];
const QUALITY_OPTIONS = [
  { value: "0.45", label: "45%" },
  { value: "0.55", label: "55%" },
  { value: "0.7", label: "70%" },
  { value: "0.85", label: "85%" },
  { value: "1", label: "100%" },
];
const BITRATE_OPTIONS = [
  { value: "1500000", label: "1.5 Mbps" },
  { value: "3000000", label: "3 Mbps" },
  { value: "6000000", label: "6 Mbps" },
  { value: "10000000", label: "10 Mbps" },
  { value: "16000000", label: "16 Mbps" },
];

const iconClass = "size-3.5";

function optionsWithCurrentValue(
  value: number,
  options: Array<{ value: string; label: string }>,
  label: (value: number) => string,
): Array<{ value: string; label: string }> {
  const current = String(value);
  return options.some((option) => option.value === current)
    ? options
    : [{ value: current, label: label(value) }, ...options];
}

export function StreamSettingsTool({
  settings,
  onPlaybackSettingsChange,
  onEncoderSettingsChange,
  activeCodec,
  avccSupported,
  peerConnection,
  webrtcStatsUrl,
  webrtcSessionId,
  encoderSettingsDisabled = false,
  transportLocked = false,
}: {
  settings: StreamControlSettings;
  onPlaybackSettingsChange: (patch: Partial<StreamPlaybackSettings>) => void;
  onEncoderSettingsChange: (patch: Partial<StreamEncoderSettings>) => void;
  activeCodec: string;
  avccSupported: boolean;
  encoderSettingsDisabled?: boolean;
  transportLocked?: boolean;
  peerConnection: RTCPeerConnection | null;
  webrtcStatsUrl?: string;
  webrtcSessionId?: string | null;
}) {
  const [open, setOpen] = useState(false);
  const { stats, history, stale } = useStreamStats(peerConnection);
  const senderView = useSenderStats(
    webrtcStatsUrl ?? "",
    webrtcSessionId ?? null,
    webrtcStatsUrl !== undefined && peerConnection !== null && webrtcSessionId != null,
  );
  const sender = senderView.stale ? null : senderView.session;
  const faults = stats === null || stale ? [] : describeFaults(stats, sender);
  const warning = stale ? "Stream samples have stopped" : faults.join("; ");
  const summary = stats === null ? null : summariseStream(stats);
  const httpActive = settings.transport === "http";
  const webrtcActive = settings.transport === "webrtc";

  return (
    <CollapsibleSection
      open={open}
      onOpenChange={setOpen}
      data-stream-settings=""
      summaryClassName="grid [grid-template-columns:auto_1fr_auto] items-center gap-2 text-left"
      summary={
        <>
          <span className="text-[11px] font-semibold text-white/50 uppercase tracking-[0.08em] leading-none inline-flex items-center">
            Stream
          </span>
          <span className="justify-self-end inline-flex items-center gap-1.5">
            {!open && summary !== null ? (
              <span className="text-[11px] text-white/40 tabular-nums">{summary}</span>
            ) : (
              <span className="text-[11px] text-white/40 uppercase">{activeCodec}</span>
            )}
            {(faults.length > 0 || stale) && (
              <span
                data-stream-warning
                role="status"
                className="group relative inline-flex items-center"
              >
                <TriangleAlert aria-hidden="true" className="w-3.5 h-3.5 text-warning" />
                <span className="sr-only">{warning}</span>
                <span className="pointer-events-none absolute right-0 top-full z-10 mt-1 hidden w-max max-w-[220px] rounded-md bg-black/90 px-2 py-1 text-[11px] leading-snug text-white/90 shadow-lg group-hover:block">
                  {warning}
                </span>
              </span>
            )}
          </span>
        </>
      }
    >
      <div className="flex flex-col gap-1.5 pb-1.5">
        <StreamStatsSection
          stats={stats}
          history={history}
          faults={faults}
          sender={sender}
          capture={senderView.stale ? null : senderView.capture}
          requestedFps={settings.h264Fps}
          stale={stale}
          action={
            <StreamStatsDownload
              history={history}
              context={{
                transport: settings.transport,
                codec: stats?.codec,
                sender,
                capture: senderView.stale ? null : senderView.capture,
              }}
            />
          }
        />
        <SettingRow icon={<Video className={iconClass} />} label="Transport">
          <SettingSelect
            label="Transport"
            value={settings.transport}
            options={transportLocked ? LOCKED_WEBRTC_TRANSPORT_OPTIONS : TRANSPORT_OPTIONS}
            disabled={transportLocked}
            onChange={(v) => onPlaybackSettingsChange({ transport: v as StreamTransport })}
          />
        </SettingRow>
        {!transportLocked && (
          <SettingRow icon={<Video className={iconClass} />} label="HTTP codec">
            <SettingSelect
              label="HTTP codec"
              value={avccSupported ? settings.httpCodec : "mjpeg"}
              options={HTTP_CODEC_OPTIONS}
              disabled={!httpActive || !avccSupported}
              onChange={(v) => onPlaybackSettingsChange({ httpCodec: v as HttpStreamCodec })}
            />
          </SettingRow>
        )}
        <SettingRow icon={<Video className={iconClass} />} label="WebRTC codec">
          <SettingSelect
            label="WebRTC codec"
            value={settings.webRtcCodec}
            options={WEBRTC_CODEC_OPTIONS}
            disabled={!webrtcActive}
            onChange={(v) => onPlaybackSettingsChange({ webRtcCodec: v as WebRtcStreamCodec })}
          />
        </SettingRow>
        <SettingRow icon={<SlidersHorizontal className={iconClass} />} label="Max size">
          <SettingSelect
            label="Max size"
            value={String(settings.maxDimension)}
            options={optionsWithCurrentValue(
              settings.maxDimension,
              MAX_DIMENSION_OPTIONS,
              String,
            )}
            disabled={encoderSettingsDisabled}
            onChange={(v) => onEncoderSettingsChange({ maxDimension: Number(v) })}
          />
        </SettingRow>
        {!transportLocked && (
          <>
            <SettingRow icon={<SlidersHorizontal className={iconClass} />} label="MJPEG FPS">
              <SettingSelect
                label="MJPEG FPS"
                value={String(settings.mjpegFps)}
                options={streamFpsOptions(settings.mjpegFps)}
                disabled={encoderSettingsDisabled || !httpActive}
                onChange={(v) => onEncoderSettingsChange({ mjpegFps: Number(v) })}
              />
            </SettingRow>
            <SettingRow icon={<SlidersHorizontal className={iconClass} />} label="MJPEG quality">
              <SettingSelect
                label="MJPEG quality"
                value={String(settings.mjpegQuality)}
                options={optionsWithCurrentValue(
                  settings.mjpegQuality,
                  QUALITY_OPTIONS,
                  (value) => `${Math.round(value * 100)}%`,
                )}
                disabled={encoderSettingsDisabled || !httpActive}
                onChange={(v) => onEncoderSettingsChange({ mjpegQuality: Number(v) })}
              />
            </SettingRow>
          </>
        )}
        <SettingRow icon={<SlidersHorizontal className={iconClass} />} label="Video FPS">
          <SettingSelect
            label="Video FPS"
            value={String(settings.h264Fps)}
            options={streamFpsOptions(settings.h264Fps)}
            disabled={
              encoderSettingsDisabled
              || (httpActive && (!avccSupported || settings.httpCodec === "mjpeg"))
            }
            onChange={(v) => onEncoderSettingsChange({ h264Fps: Number(v) })}
          />
        </SettingRow>
        <SettingRow icon={<SlidersHorizontal className={iconClass} />} label="Video bitrate">
          <SettingSelect
            label="Video bitrate"
            value={String(settings.h264Bitrate)}
            options={optionsWithCurrentValue(
              settings.h264Bitrate,
              BITRATE_OPTIONS,
              (value) => `${value / 1_000_000} Mbps`,
            )}
            disabled={
              encoderSettingsDisabled
              || (httpActive && (!avccSupported || settings.httpCodec === "mjpeg"))
            }
            onChange={(v) => onEncoderSettingsChange({ h264Bitrate: Number(v) })}
          />
        </SettingRow>
      </div>
    </CollapsibleSection>
  );
}
