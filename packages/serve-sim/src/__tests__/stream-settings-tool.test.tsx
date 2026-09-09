import { describe, expect, test } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";
import { StreamSettingsTool } from "../client/components/stream-settings-tool";

describe("StreamSettingsTool", () => {
  const settings = {
    transport: "http" as const,
    httpCodec: "h264" as const,
    webRtcCodec: "h264" as const,
    mjpegFps: 24,
    mjpegQuality: 0.8,
    maxDimension: 1024,
    h264Bitrate: 8_000_000,
    h264Fps: 24,
  };

  test("represents custom runtime encoder values instead of selecting a preset", () => {
    const html = renderToStaticMarkup(
      <StreamSettingsTool
        settings={settings}
        onPlaybackSettingsChange={() => {}}
        onEncoderSettingsChange={() => {}}
        activeCodec="h264"
        peerConnection={null}
        avccSupported
      />,
    );

    expect(html).toContain('<span class="block truncate">1024</span>');
    expect(html).toContain('<span class="block truncate">80%</span>');
    expect(html).toContain('<span class="block truncate">8 Mbps</span>');
    expect(html.match(/<span class="block truncate">24<\/span>/g)).toHaveLength(2);
  });

  test("keeps playback transport available but disables H.264 on unsupported browsers", () => {
    const html = renderToStaticMarkup(
      <StreamSettingsTool
        settings={settings}
        onPlaybackSettingsChange={() => {}}
        onEncoderSettingsChange={() => {}}
        activeCodec="mjpeg"
        peerConnection={null}
        avccSupported={false}
      />,
    );

    expect(html).not.toMatch(/aria-label="Transport"[^>]*disabled=""/);
    expect(html).toMatch(/aria-label="HTTP codec"[^>]*disabled=""/);
    expect(html).toMatch(/aria-label="Video FPS"[^>]*disabled=""/);
  });

  test("keeps shared video controls enabled for VP8 on hosts without H.264", () => {
    const html = renderToStaticMarkup(
      <StreamSettingsTool
        settings={{ ...settings, transport: "webrtc", webRtcCodec: "vp8" }}
        onPlaybackSettingsChange={() => {}}
        onEncoderSettingsChange={() => {}}
        activeCodec="webrtc/vp8"
        peerConnection={null}
        avccSupported={false}
      />,
    );

    expect(html).not.toMatch(/aria-label="Max size"[^>]*disabled=""/);
    expect(html).not.toMatch(/aria-label="Video FPS"[^>]*disabled=""/);
    expect(html).not.toMatch(/aria-label="Video bitrate"[^>]*disabled=""/);
    expect(html).toMatch(/aria-label="MJPEG FPS"[^>]*disabled=""/);
  });

  test("shows only WebRTC controls when the launch transport is locked", () => {
    const html = renderToStaticMarkup(
      <StreamSettingsTool
        settings={{ ...settings, transport: "webrtc", webRtcCodec: "vp9" }}
        onPlaybackSettingsChange={() => {}}
        onEncoderSettingsChange={() => {}}
        activeCodec="webrtc/vp9"
        peerConnection={null}
        avccSupported
        transportLocked
      />,
    );

    expect(html).toMatch(/aria-label="Transport"[^>]*disabled=""/);
    expect(html).not.toContain("HTTP codec");
    expect(html).not.toContain("MJPEG FPS");
    expect(html).not.toContain("MJPEG quality");
    expect(html).not.toMatch(/aria-label="WebRTC codec"[^>]*disabled=""/);
    expect(html).not.toMatch(/aria-label="Video FPS"[^>]*disabled=""/);
    expect(html).not.toMatch(/aria-label="Video bitrate"[^>]*disabled=""/);
  });
});
