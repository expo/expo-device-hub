import { describe, expect, test } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";
import {
  ClipboardToastContent,
  pasteFieldHint,
  ShareLinkToastContent,
  UploadToastContent,
} from "../client/components/app-toasts";

describe("UploadToastContent", () => {
  test("labels a queued folder without showing upload progress", () => {
    const html = renderToStaticMarkup(
      <UploadToastContent
        toast={{ id: "q", name: "Two.app", kind: "app", status: "queued", progress: 0 }}
      />,
    );
    expect(html).toContain("Waiting to upload Two.app…");
    expect(html).not.toContain("0%");
    expect(html).not.toContain("serve-sim-toast-indeterminate");
  });

  test("shows full error guidance with an accessible dismissal", () => {
    const html = renderToStaticMarkup(
      <UploadToastContent
        toast={{
          id: "e",
          name: "Photos",
          kind: "app",
          status: "error",
          progress: null,
          message: "Drop a Simulator .app folder or a .tar.gz/.tgz archive.",
        }}
        onDismiss={() => {}}
      />,
    );
    expect(html).toContain("whitespace-normal");
    expect(html).not.toContain("text-ellipsis");
    expect(html).toContain('aria-label="Dismiss upload error"');
  });
  test("renders determinate upload progress", () => {
    const html = renderToStaticMarkup(
      <UploadToastContent
        toast={{
          id: "1",
          name: "clip.mov",
          kind: "media",
          status: "uploading",
          progress: 0.42,
        }}
      />,
    );

    expect(html).toContain('data-testid="upload-toast"');
    expect(html).toContain("Uploading clip.mov… 42%");
    expect(html).toContain("width:42%");
  });

  test("renders completed media and ipa messages", () => {
    const media = renderToStaticMarkup(
      <UploadToastContent
        toast={{ id: "1", name: "photo.png", kind: "media", status: "success", progress: null }}
      />,
    );
    const ipa = renderToStaticMarkup(
      <UploadToastContent
        toast={{ id: "2", name: "App.tgz", kind: "app", status: "success", progress: null }}
      />,
    );

    expect(media).toContain("Added photo.png to Photos");
    expect(ipa).toContain("Installed App.tgz");
  });
});

describe("ShareLinkToastContent", () => {
  const url = "http://host:3399/?token=tok";

  test("confirms the copy and warns about the token", () => {
    const html = renderToStaticMarkup(
      <ShareLinkToastContent toast={{ url, copied: true, carriesToken: true }} />,
    );

    expect(html).toContain("Share link copied");
    expect(html).toContain("includes the access token");
    expect(html).toContain("can control this simulator");
    expect(html).not.toContain("<input");
  });

  test("confirms the copy of a link with no token", () => {
    const html = renderToStaticMarkup(
      <ShareLinkToastContent
        toast={{ url: "http://host:3399/", copied: true, carriesToken: false }}
      />,
    );

    expect(html).toContain("Share link copied");
    expect(html).toContain("Anyone who can reach this address");
    expect(html).not.toContain("access token");
  });

  test("shows the link to copy by hand when the clipboard is unavailable", () => {
    const html = renderToStaticMarkup(
      <ShareLinkToastContent toast={{ url, copied: false, carriesToken: true }} />,
    );

    expect(html).toContain("Copy this share link");
    expect(html).toContain(`value="${url}"`);
    expect(html).toContain('aria-label="Share link"');
    expect(html).toContain("includes the access token");
  });
});

describe("ClipboardToastContent", () => {
  test("renders the message above a paste field in the paste state", () => {
    const html = renderToStaticMarkup(
      <ClipboardToastContent
        toast={{ status: "paste", message: "Paste here to send it to the simulator" }}
        onPaste={() => {}}
      />,
    );
    expect(html).toContain('aria-label="Text to paste into the simulator"');
    expect(html).toContain('data-suspend-keyboard-capture="true"');
    expect(html).toContain("<textarea");
    expect(html).not.toContain("<input");
    expect(html).toContain(">Send</button>");
    expect(html).toContain("Paste here to send it to the simulator");
    expect(html).toContain('placeholder="Press ⌘V or Ctrl+V to paste"');
    expect(html).not.toContain("autofocus");
  });

  test("tells touch users to long-press and desktop users to press a paste shortcut", () => {
    expect(pasteFieldHint(true)).toBe("Long-press and paste");
    expect(pasteFieldHint(false)).toBe("Press ⌘V or Ctrl+V to paste");
  });

  test("shows a Copy button only in the manual state", () => {
    const html = renderToStaticMarkup(
      <ClipboardToastContent toast={{ status: "manual", message: "Ready — one click to copy" }} />,
    );
    expect(html).toContain("Ready — one click to copy");
    expect(html).toContain(">Copy</button>");
    for (const status of ["success", "error"] as const) {
      const other = renderToStaticMarkup(
        <ClipboardToastContent
          toast={{ status, message: "Copied from simulator" }}
          onCopy={() => {}}
        />,
      );
      expect(other).toContain("Copied from simulator");
      expect(other).not.toContain(">Copy</button>");
    }
  });
});
