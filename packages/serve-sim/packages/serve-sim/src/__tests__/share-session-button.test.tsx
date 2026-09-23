import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import type { ReactElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";

type CustomCall = { render: () => ReactElement; options: { id: string; duration: number } };
const customCalls: CustomCall[] = [];
mock.module("sonner", () => ({
  Toaster: () => null,
  toast: {
    custom: (render: () => ReactElement, options: { id: string; duration: number }) => {
      customCalls.push({ render, options });
    },
  },
}));

import { ShareSessionButton } from "../client/components/share-session-button";

describe("ShareSessionButton", () => {
  test("says in the tooltip when the link includes the token", () => {
    const gated = renderToStaticMarkup(
      <ShareSessionButton config={{ requireToken: true, execToken: "tok" }} />,
    );
    const open = renderToStaticMarkup(<ShareSessionButton config={{ execToken: "tok" }} />);

    expect(gated).toContain('aria-label="Share session"');
    expect(gated).toContain('title="Copy share link (includes access token)"');
    expect(open).toContain('title="Copy share link"');
    expect(open).not.toContain("access token");
  });
});

describe("ShareSessionButton click", () => {
  const realNavigator = globalThis.navigator;

  beforeEach(() => {
    customCalls.length = 0;
    (globalThis as { window?: unknown }).window = {
      location: { origin: "http://10.0.1.5:3477", pathname: "/", search: "?device=ABC" },
    };
  });

  afterEach(() => {
    delete (globalThis as { window?: unknown }).window;
    Object.defineProperty(globalThis, "navigator", {
      value: realNavigator,
      configurable: true,
      writable: true,
    });
  });

  function setClipboard(clipboard: unknown) {
    Object.defineProperty(globalThis, "navigator", {
      value: clipboard,
      configurable: true,
      writable: true,
    });
  }

  async function click(config: { requireToken?: boolean; execToken?: string; shareUrl?: string } | null) {
    const element = ShareSessionButton({ config }) as ReactElement<{ onClick: () => void }>;
    element.props.onClick();
    const deadline = Date.now() + 1000;
    while (customCalls.length === 0 && Date.now() < deadline) {
      await new Promise((resolve) => setTimeout(resolve, 5));
    }
  }

  test("copies the tokened link and shows the confirmation toast", async () => {
    const written: string[] = [];
    setClipboard({ clipboard: { writeText: async (text: string) => void written.push(text) } });

    await click({ requireToken: true, execToken: "tok-1" });

    expect(written).toEqual(["http://10.0.1.5:3477/?device=ABC&token=tok-1"]);
    expect(customCalls).toHaveLength(1);
    expect(customCalls[0]!.options.id).toBe("share-session-link");
    expect(renderToStaticMarkup(customCalls[0]!.render())).toContain("Share link copied");
  });

  test("copies --share-url instead of the preview address", async () => {
    const written: string[] = [];
    setClipboard({ clipboard: { writeText: async (text: string) => void written.push(text) } });

    await click({
      requireToken: true,
      execToken: "tok-1",
      shareUrl: "https://expo.dev/simulator-preview/abc",
    });

    expect(written).toEqual(["https://expo.dev/simulator-preview/abc?token=tok-1"]);
    expect(renderToStaticMarkup(customCalls[0]!.render())).toContain("access token");
  });

  test("shows the link to copy by hand when the copy fails, and leaves it up longer", async () => {
    setClipboard({});

    await click(null);

    expect(customCalls).toHaveLength(1);
    expect(customCalls[0]!.options.duration).toBeGreaterThan(10_000);
    expect(renderToStaticMarkup(customCalls[0]!.render())).toContain("Copy this share link");
  });
});
