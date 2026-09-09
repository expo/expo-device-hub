import { describe, expect, test } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";
import {
  GrpcImageModeSelector,
  StreamStatsDownloadControl,
  StreamModePanel,
  ViewerTransportSelector,
} from "../src/ui/components/stream-mode-panel";

describe("StreamModePanel", () => {
  test("renders an accessible, unavailable-until-loaded radio group", () => {
    const markup = renderToStaticMarkup(<StreamModePanel />);

    expect(markup).toContain('role="status"');
    expect(markup).toContain('aria-live="polite"');
    expect(markup).toContain('aria-atomic="true"');
    expect(markup).toContain('aria-busy="true"');
    expect(markup).toContain('aria-describedby="stream-mode-help"');
    expect(markup).toContain('<legend class="visually-hidden">Stream source</legend>');
    expect(markup).toContain('type="radio"');
    expect(markup.match(/type="radio"/g)?.length).toBe(4);
    expect(markup.match(/<input type="radio"[^>]*disabled=""/g)?.length).toBe(4);
    expect(markup).toContain('value="scrcpy"');
    expect(markup).toContain('value="grpc-screenshot"');
    expect(markup).toContain("On-device capture");
    expect(markup).toContain("Emulator host capture");
    expect(markup).toContain("Checking the available stream sources…");
    expect(markup).toContain("Browser transport");
    expect(markup).toContain('name="viewer-transport"');
    expect(markup).toContain('value="websocket"');
    expect(markup).toContain('value="webrtc"');
    expect(markup).toContain("Loading viewer transports…");
    expect(markup).toContain("Download stats");
    expect(markup).toContain(
      "Download a redacted JSON snapshot of viewer and server statistics.",
    );
    expect(markup).not.toContain("gRPC image mode");
  });

  test("renders accessible stats download feedback and pending state", () => {
    const idleMarkup = renderToStaticMarkup(
      <StreamStatsDownloadControl
        disabled={false}
        status="idle"
        message={null}
        onDownload={() => {}}
      />,
    );
    expect(idleMarkup).toContain('type="button"');
    expect(idleMarkup).toContain(
      'aria-describedby="stream-stats-download-feedback"',
    );
    expect(idleMarkup).toContain('role="status"');
    expect(idleMarkup).toContain("Download stats");

    const pendingMarkup = renderToStaticMarkup(
      <StreamStatsDownloadControl
        disabled={false}
        status="downloading"
        message="Collecting viewer and server statistics…"
        onDownload={() => {}}
      />,
    );
    expect(pendingMarkup).toContain('disabled=""');
    expect(pendingMarkup).toContain("Preparing stats…");

    const errorMarkup = renderToStaticMarkup(
      <StreamStatsDownloadControl
        disabled={false}
        status="error"
        message="Could not download stream stats."
        onDownload={() => {}}
      />,
    );
    expect(errorMarkup).toContain('role="alert"');
    expect(errorMarkup).toContain('aria-live="assertive"');
    expect(errorMarkup).toContain("Could not download stream stats.");
  });

  test("renders viewer-local transport choices with live switching feedback", () => {
    const liveMarkup = renderToStaticMarkup(
      <ViewerTransportSelector
        value="websocket"
        available={["websocket", "webrtc"]}
        switchingTo={null}
        error={null}
        onChange={() => {}}
      />,
    );

    expect(liveMarkup).toContain("<legend>Browser transport</legend>");
    expect(liveMarkup.match(/name="viewer-transport"/g)?.length).toBe(2);
    expect(liveMarkup).toContain('checked="" value="websocket"');
    expect(liveMarkup).toContain('aria-busy="false"');
    expect(liveMarkup).toContain('data-state="live"');
    expect(liveMarkup).toContain("WebSocket live");

    const switchingMarkup = renderToStaticMarkup(
      <ViewerTransportSelector
        value="webrtc"
        available={["websocket", "webrtc"]}
        switchingTo="webrtc"
        error={null}
        onChange={() => {}}
      />,
    );
    expect(switchingMarkup).toContain('aria-busy="true"');
    expect(switchingMarkup).toContain('data-state="switching"');
    expect(switchingMarkup).toContain("Switching to WebRTC…");

    const errorMarkup = renderToStaticMarkup(
      <ViewerTransportSelector
        value="webrtc"
        available={["websocket"]}
        switchingTo={null}
        error="WebRTC unavailable"
        onChange={() => {}}
      />,
    );
    expect(errorMarkup).toContain('disabled="" checked="" value="webrtc"');
    expect(errorMarkup).toContain('data-state="error"');
    expect(errorMarkup).toContain("WebRTC unavailable");
  });

  test("renders an accessible explicit PNG/MMAP selector for the gRPC source", () => {
    const markup = renderToStaticMarkup(
      <GrpcImageModeSelector
        value="mmap"
        disabled={false}
        onChange={() => {}}
      />,
    );

    expect(markup).toContain("<legend>gRPC image mode</legend>");
    expect(markup).toContain('aria-describedby="stream-mode-help"');
    expect(markup.match(/name="grpc-image-mode"/g)?.length).toBe(2);
    expect(markup).toContain('value="png"');
    expect(markup).toContain('checked="" value="mmap"');
    expect(markup).toContain("Compressed in-band images");
    expect(markup).toContain("Shared-memory raw pixels");
    expect(markup).not.toContain("disabled");

    const disabledMarkup = renderToStaticMarkup(
      <GrpcImageModeSelector
        value="png"
        disabled
        onChange={() => {}}
      />,
    );
    expect(disabledMarkup).toContain("<fieldset");
    expect(disabledMarkup).toContain("disabled=\"\"");
  });
});
