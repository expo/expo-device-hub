import { describe, expect, test } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";
import { act, create, type ReactTestRenderer } from "react-test-renderer";
import {
  ClipboardToastContent,
  pasteFieldHint,
  ShareLinkToastContent,
  UploadToastContent,
} from "../client/components/app-toasts";
import { APP_FOLDER_GUIDANCE, APP_FOLDER_UNREADABLE } from "../client/utils/app-drop-folder";

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
    // Red marks errors only.
    expect(html).not.toContain("#f87171");
  });

  test("titles guidance with the file name and keeps an accessible dismissal", () => {
    const html = renderToStaticMarkup(
      <UploadToastContent
        toast={{
          id: "e",
          name: "Photos",
          kind: "app",
          status: "error",
          progress: null,
          message: APP_FOLDER_GUIDANCE,
        }}
        onDismiss={() => {}}
      />,
    );
    expect(html).toContain('font-medium">Photos</span> is not a Simulator app');
    expect(html).toContain("Drop a Simulator .app folder or a .tar.gz archive.");
    expect(html).toContain('aria-label="Dismiss upload error"');
    expect(html).not.toContain("text-ellipsis");
    expect(html).not.toContain("Details");
  });

  test("keeps a multi-line host error under Details with a Copy button", () => {
    const html = renderToStaticMarkup(
      <UploadToastContent
        toast={{
          id: "f",
          name: "App.app",
          kind: "app",
          status: "error",
          progress: null,
          message: "install failed\nsecond line",
        }}
      />,
    );
    expect(html).toContain("Could not install");
    expect(html).toContain("line-clamp-2");
    expect(html).toContain('aria-expanded="false"');
    expect(html).toContain("Copy</button>");
    expect(html).toMatch(/<pre[^>]*hidden=""[^>]*>install failed\nsecond line<\/pre>/);
  });

  test("shows open Details and does not clamp fixed advice", () => {
    const error = {
      id: "o",
      name: "App.app",
      kind: "app",
      status: "error",
      progress: null,
    } as const;
    const open = renderToStaticMarkup(
      <UploadToastContent toast={{ ...error, message: "failed\nline two", detailsOpen: true }} />,
    );
    expect(open).toContain('aria-expanded="true"');
    expect(open).not.toContain('hidden=""');
    const unreadable = renderToStaticMarkup(
      <UploadToastContent
        toast={{ ...error, message: `${APP_FOLDER_UNREADABLE}\naccess denied.` }}
      />,
    );
    expect(unreadable).toContain("Details");
    expect(unreadable).not.toContain("line-clamp-2");
  });

  test("Details and a failed Copy both ask to open the full error", async () => {
    Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
    let toggles = 0;
    let renderer!: ReactTestRenderer;
    await act(async () => {
      renderer = create(
        <UploadToastContent
          toast={{
            id: "c",
            name: "App.app",
            kind: "app",
            status: "error",
            progress: null,
            message: "install failed\nsecond line",
          }}
          onToggleDetails={() => toggles++}
        />,
      );
    });
    const click = (label: string) =>
      act(async () => {
        renderer.root
          .find((node) => node.type === "button" && node.children.includes(label))
          .props.onClick();
        await Bun.sleep(0);
      });
    await click("Details");
    // Bun has no clipboard and no DOM, so Copy opens the details for a manual copy.
    await click("Copy");
    expect(toggles).toBe(2);
    Object.defineProperty(navigator, "clipboard", {
      configurable: true,
      value: { writeText: async () => {} },
    });
    try {
      await click("Copy");
      expect(toggles).toBe(2);
      expect(JSON.stringify(renderer.toJSON())).toContain("Copied");
    } finally {
      delete (navigator as { clipboard?: unknown }).clipboard;
      await act(async () => renderer.unmount());
    }
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
