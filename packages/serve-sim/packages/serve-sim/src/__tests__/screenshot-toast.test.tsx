import { describe, expect, test } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";
import {
  ScreenshotToast,
  shouldDismissScreenshotToastAfterDrag,
} from "../client/components/screenshot-toast";
import {
  revealParams,
  type ScreenshotToast as ScreenshotToastState,
} from "../client/hooks/use-screenshot-toast";

const noop = () => {};

function render(toast: ScreenshotToastState): string {
  return renderToStaticMarkup(
    <ScreenshotToast
      toast={toast}
      onReveal={noop}
      onDismiss={noop}
      onPause={noop}
      onResume={noop}
    />,
  );
}

describe("ScreenshotToast drag image", () => {
  test("dismisses after a completed drag but not a cancelled drag", () => {
    expect(shouldDismissScreenshotToastAfterDrag("copy")).toBe(true);
    expect(shouldDismissScreenshotToastAfterDrag("move")).toBe(true);
    expect(shouldDismissScreenshotToastAfterDrag("none")).toBe(false);
  });

  test("saved toast with a thumb renders an offscreen drag-image element", () => {
    const html = render({
      id: "1",
      status: "saved",
      phase: "in",
      path: "/Users/x/Desktop/shot.png",
      thumb: "data:image/png;base64,AAAA",
    });
    expect(html).toContain('data-testid="drag-image"');
    // Parked far above the viewport via inline style — a Tailwind class here
    // can silently miss the build scan, and position:fixed would resolve
    // against the wrapper's -translate-x-1/2 containing block, both of which
    // leave the image visible in the page.
    expect(html).toMatch(/data-testid="drag-image"[^>]*style="[^"]*position:absolute/);
    expect(html).toMatch(/data-testid="drag-image"[^>]*style="[^"]*top:-9999px/);
  });

  test("toast without a thumb renders no drag-image element", () => {
    const html = render({
      id: "1",
      status: "saved",
      phase: "in",
      path: "/Users/x/Desktop/shot.png",
    });
    expect(html).not.toContain('data-testid="drag-image"');
  });

  test("remote screenshot offers another browser download instead of Finder", () => {
    const html = render({
      id: "1",
      status: "saved",
      phase: "in",
      downloadUrl: "blob:https://preview.example/shot",
      downloadName: "serve-sim-screenshot.png",
      thumb: "blob:https://preview.example/shot",
    });

    expect(html).toContain('aria-label="Download screenshot again"');
    expect(html).toContain("Download again");
    expect(html).not.toContain("Open in Finder");
    expect(html).not.toContain("draggable=\"true\"");
  });

  test("local screenshot retains Finder and drag behavior", () => {
    const html = render({
      id: "1",
      status: "saved",
      phase: "in",
      path: "/Users/x/Desktop/shot.png",
    });

    expect(html).toContain('aria-label="Open screenshot in Finder"');
    expect(html).toContain("Open in Finder");
    expect(html).toContain('draggable="true"');
  });
});

describe("ScreenshotToast staged-only capture", () => {
  const STAGED = "/Users/x/Library/Caches/serve-sim/screenshots/shot.png";
  const MESSAGE =
    "This host refused the Desktop copy (cp: Operation not permitted), which usually means " +
    "Desktop access is denied for the process running this preview, so the screenshot stays " +
    `staged at ${STAGED} for at least 6 hours.`;

  test("shows the host's sentence when the Desktop has no copy", () => {
    const html = render({
      id: "1",
      status: "saved",
      phase: "in",
      path: STAGED,
      fileName: "shot.png",
      stagedOnly: true,
      message: MESSAGE,
    });
    expect(html).toContain("Screenshot Saved");
    expect(html).toContain("Open in Finder");
    expect(html).toContain(MESSAGE);
  });

  test("a copied capture renders no extra line", () => {
    const html = render({
      id: "1",
      status: "saved",
      phase: "in",
      path: STAGED,
      fileName: "shot.png",
    });
    expect(html).toContain("Open in Finder");
    expect(html).not.toContain("stays staged");
  });
});

describe("revealParams", () => {
  test("a copied capture reveals the Desktop copy by name", () => {
    expect(
      revealParams({
        id: "1",
        status: "saved",
        phase: "in",
        path: "/Users/x/Library/Caches/serve-sim/screenshots/shot.png",
        fileName: "shot.png",
      }),
    ).toEqual({ screenshot: "shot.png" });
  });

  test("a staged-only capture reveals the staged path", () => {
    expect(
      revealParams({
        id: "1",
        status: "saved",
        phase: "in",
        path: "/Users/x/Library/Caches/serve-sim/screenshots/shot.png",
        fileName: "shot.png",
        stagedOnly: true,
        message: "This host would not let the screenshot be copied to the Desktop.",
      }),
    ).toEqual({ path: "/Users/x/Library/Caches/serve-sim/screenshots/shot.png" });
  });

  test("a browser download has nothing on the host to reveal", () => {
    expect(
      revealParams({
        id: "1",
        status: "saved",
        phase: "in",
        downloadUrl: "blob:https://preview.example/shot",
        downloadName: "shot.png",
      }),
    ).toBeNull();
  });
});
