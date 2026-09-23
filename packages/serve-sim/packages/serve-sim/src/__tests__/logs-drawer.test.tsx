import { describe, expect, test } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";
import { LogsDrawer } from "../client/components/logs-drawer";

describe("LogsDrawer", () => {
  test("renders the bottom-drawer chrome when open", () => {
    const html = renderToStaticMarkup(
      <LogsDrawer
        open
        onClose={() => {}}
        udid="DEVICE"
        logsEndpoint="/logs"
        currentAppPid={99}
        height={320}
        leftInset={0}
        rightInset={0}
        onResizePointerDown={() => {}}
      />
    );

    expect(html).toContain("data-logs");
    expect(html).toContain("translateY(0)");
    expect(html).toContain("All processes");
    expect(html).toContain("Current app");
    expect(html).toContain("Log levels");
    expect(html).toContain("Filter");
    expect(html).toContain("Resize logs drawer");
  });

  test("disables the app scope until a foreground app is known", () => {
    const render = (currentAppPid: number | null): string =>
      renderToStaticMarkup(
        <LogsDrawer
          open
          onClose={() => {}}
          udid="DEVICE"
          logsEndpoint="/logs"
          currentAppPid={currentAppPid}
          height={320}
          leftInset={0}
          rightInset={0}
          onResizePointerDown={() => {}}
        />
      );

    expect(render(null)).toContain('aria-label="Current app" disabled=""');
    expect(render(99)).not.toContain('aria-label="Current app" disabled=""');
  });

  test("stays open but out of sight while hidden", () => {
    const html = renderToStaticMarkup(
      <LogsDrawer
        open
        hidden
        onClose={() => {}}
        udid="DEVICE"
        logsEndpoint="/logs"
        height={320}
        leftInset={0}
        rightInset={0}
        onResizePointerDown={() => {}}
      />
    );

    expect(html).toContain("translateY(100%)");
    expect(html).toContain('aria-hidden="true"');
  });

  test("slides off-screen when closed", () => {
    const html = renderToStaticMarkup(
      <LogsDrawer
        open={false}
        onClose={() => {}}
        udid="DEVICE"
        logsEndpoint="/logs"
        height={320}
        leftInset={0}
        rightInset={0}
        onResizePointerDown={() => {}}
      />
    );

    expect(html).toContain("translateY(100%)");
    expect(html).toContain('aria-hidden="true"');
  });
});
