import { expect, spyOn, test } from "bun:test";
import { act, create, type ReactTestRenderer } from "react-test-renderer";
import { renderToStaticMarkup } from "react-dom/server";
import { toast } from "sonner";
import type { DeviceClient } from "@expo/hub-client";

import { MODEL_UNAVAILABLE_TEXT, ModelPreviewToast } from "../dashboard/ModelPreviewToast";
import { PhoneFrame, type PhoneFrameFoldPreview } from "../dashboard/PhoneFrame";
import { StreamPanel } from "../dashboard/StreamPanel";
import { createGlobalStubs } from "./test-globals";

const client = {
  status: "streaming",
  screen: { width: 375, height: 667 },
  capabilities: { clipboard: false },
  clipboardPending: null,
  deviceSettings: {},
  deviceSettingsPending: new Set(),
} as unknown as DeviceClient;

const device = (id: string) => ({
  id,
  name: "Phone",
  platform: "ios" as const,
  version: "27",
  booted: true,
  physical: false,
  supported: true,
});

function browser() {
  const { stubGlobal, restoreGlobals } = createGlobalStubs();
  stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  class Element {}
  stubGlobal("HTMLElement", Element);
  stubGlobal(
    "MutationObserver",
    class {
      observe() {}
      disconnect() {}
    },
  );
  stubGlobal("document", {
    documentElement: { getAttribute: () => "ltr" },
    addEventListener() {},
    removeEventListener() {},
  });
  stubGlobal("requestAnimationFrame", () => 0);
  stubGlobal("window", {
    innerWidth: 1280,
    innerHeight: 800,
    matchMedia: () => ({ matches: false, addEventListener() {}, removeEventListener() {} }),
    addEventListener() {},
    removeEventListener() {},
    // The toolbar's tooltips keep their open delay on window timers.
    setTimeout,
    clearTimeout,
  });
  return restoreGlobals;
}

const panel = (id: string, foldPreview: PhoneFrameFoldPreview) => (
  <StreamPanel
    device={device(id)}
    client={client}
    DeviceScreen={() => null}
    displayScreen={(screen) => screen ?? null}
    foldPreview={foldPreview}
  />
);

test("a failed 3D model shows a notice that leaves by itself, and tells the consumer", async () => {
  const restoreGlobals = browser();
  const shown = spyOn(toast, "custom").mockImplementation(() => "test");
  const dismissed = spyOn(toast, "dismiss").mockImplementation(() => "test");
  let renderer: ReactTestRenderer | undefined;
  let reported = 0;
  const foldPreview: PhoneFrameFoldPreview = { mode: "3d", onUnavailable: () => reported++ };
  try {
    await act(async () => {
      renderer = create(panel("one", foldPreview));
    });
    const fail = () => renderer!.root.findByType(PhoneFrame).props.foldPreview.onUnavailable();
    await act(async () => fail());
    expect(reported).toBe(1);
    // The notice waits for the commit to end: a model can fail before the toaster listens.
    expect(shown).not.toHaveBeenCalled();
    await act(async () => new Promise((resolve) => setTimeout(resolve, 5)));
    expect(shown).toHaveBeenCalledTimes(1);
    const options = shown.mock.calls[0]![1]!;
    // Over the device, in the toaster that the clipboard notices use, for five seconds.
    expect(options).toMatchObject({ toasterId: "hub-clipboard", duration: 5000 });
    // Another device does not keep the notice of the one before, and its own notice has a new
    // id, so the dismissal cannot take it too.
    dismissed.mockClear();
    await act(async () => {
      renderer!.update(panel("two", foldPreview));
    });
    expect(dismissed).toHaveBeenCalledWith(options.id);
    await act(async () => {
      fail();
      await new Promise((resolve) => setTimeout(resolve, 5));
    });
    expect(shown).toHaveBeenCalledTimes(2);
    expect(shown.mock.calls[1]![1]!.id).not.toBe(options.id);
    // A device that leaves before the notice shows gets none.
    act(() => {
      fail();
      renderer!.update(panel("three", foldPreview));
    });
    await act(async () => new Promise((resolve) => setTimeout(resolve, 5)));
    expect(shown).toHaveBeenCalledTimes(2);
  } finally {
    if (renderer) await act(async () => renderer!.unmount());
    shown.mockRestore();
    dismissed.mockRestore();
    restoreGlobals();
  }
});

test("without a handler, the model keeps its own notice and the panel shows none", async () => {
  const restoreGlobals = browser();
  const shown = spyOn(toast, "custom").mockImplementation(() => "test");
  let renderer: ReactTestRenderer | undefined;
  const foldPreview: PhoneFrameFoldPreview = { mode: "3d" };
  try {
    await act(async () => {
      renderer = create(panel("one", foldPreview));
    });
    expect(renderer!.root.findByType(PhoneFrame).props.foldPreview).toBe(foldPreview);
    expect(shown).not.toHaveBeenCalled();
  } finally {
    if (renderer) await act(async () => renderer!.unmount());
    shown.mockRestore();
    restoreGlobals();
  }
});

test("the notice says that the preview is in 2D", () => {
  const markup = renderToStaticMarkup(<ModelPreviewToast />);
  expect(markup).toContain(MODEL_UNAVAILABLE_TEXT);
  expect(markup).toContain('role="status"');
});
