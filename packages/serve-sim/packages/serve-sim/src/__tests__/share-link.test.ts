import { afterEach, describe, expect, test } from "bun:test";

import {
  copyTextToClipboard,
  previewShareUrl,
  shareLinkCarriesToken,
} from "../client/utils/share-link";

const at = (pathname: string, search = "") => ({
  origin: "http://192.168.1.20:3399",
  pathname,
  search,
});

describe("previewShareUrl", () => {
  test("adds the token when the preview is gated", () => {
    expect(previewShareUrl(at("/"), { requireToken: true, execToken: "tok-1" })).toBe(
      "http://192.168.1.20:3399/?token=tok-1",
    );
  });

  test("omits the exec token when the preview is not gated", () => {
    expect(previewShareUrl(at("/"), { execToken: "tok-1" })).toBe("http://192.168.1.20:3399/");
    expect(previewShareUrl(at("/"), { requireToken: false, execToken: "tok-1" })).toBe(
      "http://192.168.1.20:3399/",
    );
    expect(previewShareUrl(at("/"), null)).toBe("http://192.168.1.20:3399/");
  });

  test("omits the token when the gated config has none to share", () => {
    expect(previewShareUrl(at("/"), { requireToken: true })).toBe("http://192.168.1.20:3399/");
    expect(previewShareUrl(at("/"), { requireToken: true, execToken: "" })).toBe(
      "http://192.168.1.20:3399/",
    );
  });

  test("keeps the device selection and the mount path", () => {
    expect(
      previewShareUrl(at("/preview", "?device=ABC"), { requireToken: true, execToken: "tok-1" }),
    ).toBe("http://192.168.1.20:3399/preview?device=ABC&token=tok-1");
  });

  test("replaces a token already in the address", () => {
    expect(previewShareUrl(at("/", "?token=stale"), { requireToken: true, execToken: "tok-1" })).toBe(
      "http://192.168.1.20:3399/?token=tok-1",
    );
    expect(previewShareUrl(at("/", "?token=stale"), null)).toBe("http://192.168.1.20:3399/");
  });

  test("escapes a token that is not url-safe", () => {
    expect(previewShareUrl(at("/"), { requireToken: true, execToken: "a b&c" })).toBe(
      "http://192.168.1.20:3399/?token=a+b%26c",
    );
  });

  test("uses --share-url instead of the preview origin, and still adds the token", () => {
    expect(
      previewShareUrl(at("/preview", "?device=ABC"), {
        requireToken: true,
        execToken: "tok-1",
        shareUrl: "https://expo.dev/simulator-preview/abc",
      }),
    ).toBe("https://expo.dev/simulator-preview/abc?token=tok-1");
  });

  test("does not add a token to --share-url when the preview is not gated", () => {
    expect(
      previewShareUrl(at("/"), {
        execToken: "tok-1",
        shareUrl: "https://expo.dev/simulator-preview/abc",
      }),
    ).toBe("https://expo.dev/simulator-preview/abc");
  });

  test("replaces a token already on --share-url", () => {
    expect(
      previewShareUrl(at("/"), {
        requireToken: true,
        execToken: "tok-1",
        shareUrl: "https://expo.dev/simulator-preview/abc?token=stale",
      }),
    ).toBe("https://expo.dev/simulator-preview/abc?token=tok-1");
  });
});

describe("shareLinkCarriesToken", () => {
  test("is true only when gated and a token is known", () => {
    expect(shareLinkCarriesToken({ requireToken: true, execToken: "t" })).toBe(true);
    expect(shareLinkCarriesToken({ requireToken: true })).toBe(false);
    expect(shareLinkCarriesToken({ requireToken: true, execToken: "" })).toBe(false);
    expect(shareLinkCarriesToken({ execToken: "t" })).toBe(false);
    expect(shareLinkCarriesToken(null)).toBe(false);
  });
});

describe("copyTextToClipboard", () => {
  const realNavigator = globalThis.navigator;
  const realDocument = (globalThis as { document?: unknown }).document;

  function fakeDocument(copy: () => boolean) {
    const appended: unknown[] = [];
    const area = {
      value: "",
      style: {} as Record<string, string>,
      range: null as [number, number] | null,
      removed: false,
      setAttribute() {},
      select() {},
      setSelectionRange(start: number, end: number) {
        this.range = [start, end];
      },
      remove() {
        this.removed = true;
      },
    };
    return {
      area,
      appended,
      document: {
        createElement: () => area,
        body: { appendChild: (el: unknown) => appended.push(el) },
        execCommand: copy,
      },
    };
  }

  function install(navigator: unknown, document: unknown) {
    Object.defineProperty(globalThis, "navigator", {
      value: navigator,
      configurable: true,
      writable: true,
    });
    (globalThis as { document?: unknown }).document = document;
  }

  afterEach(() => {
    install(realNavigator, realDocument);
  });

  test("uses the async clipboard when it is available", async () => {
    const written: string[] = [];
    const { document, appended } = fakeDocument(() => true);
    install({ clipboard: { writeText: async (text: string) => void written.push(text) } }, document);

    expect(await copyTextToClipboard("http://host/?token=t")).toBe(true);
    expect(written).toEqual(["http://host/?token=t"]);
    expect(appended).toEqual([]);
  });

  test("falls back to a selection copy when there is no async clipboard", async () => {
    const { document, area, appended } = fakeDocument(() => true);
    install({}, document);

    expect(await copyTextToClipboard("link")).toBe(true);
    expect(appended).toEqual([area]);
    expect(area.value).toBe("link");
    expect(area.range).toEqual([0, 4]);
    expect(area.removed).toBe(true);
  });

  test("falls back when the async clipboard rejects", async () => {
    const { document, appended } = fakeDocument(() => true);
    install({ clipboard: { writeText: async () => { throw new Error("denied"); } } }, document);

    expect(await copyTextToClipboard("link")).toBe(true);
    expect(appended).toHaveLength(1);
  });

  test("reports failure when the selection copy is refused", async () => {
    const { document, area } = fakeDocument(() => false);
    install({}, document);

    expect(await copyTextToClipboard("link")).toBe(false);
    expect(area.removed).toBe(true);
  });

  test("reports failure when the selection copy throws, and cleans up", async () => {
    const { document, area } = fakeDocument(() => { throw new Error("blocked"); });
    install({}, document);

    expect(await copyTextToClipboard("link")).toBe(false);
    expect(area.removed).toBe(true);
  });

  test("reports failure when there is no document at all", async () => {
    install({}, undefined);

    expect(await copyTextToClipboard("link")).toBe(false);
  });
});
