import { expect, test, spyOn } from "bun:test";
import { act, create, type ReactTestRenderer } from "react-test-renderer";
import { toast } from "sonner";
import type { DeviceClient } from "@expo/hub-client";
import { StreamPanel } from "../dashboard/StreamPanel";
import { PhoneFrame } from "../dashboard/PhoneFrame";
import { createGlobalStubs } from "./test-globals";

test("denied browser copy leaves mobile presentation and opens the fallback", async () => {
  const { stubGlobal, restoreGlobals } = createGlobalStubs();
  stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  stubGlobal("document", {
    documentElement: { getAttribute: () => "ltr" },
    addEventListener() {},
    removeEventListener() {},
  });
  stubGlobal("requestAnimationFrame", () => 0);
  stubGlobal("window", {
    innerWidth: 375,
    innerHeight: 667,
    visualViewport: {
      width: 375,
      height: 667,
      offsetTop: 0,
      offsetLeft: 0,
      addEventListener() {},
      removeEventListener() {},
    },
    matchMedia: () => ({ matches: true, addEventListener() {}, removeEventListener() {} }),
    addEventListener() {},
    removeEventListener() {},
  });
  stubGlobal("navigator", {
    clipboard: {
      writeText: async () => {
        throw new Error("denied");
      },
    },
  });
  const shown = spyOn(toast, "custom").mockImplementation(() => "test");
  let renderer: ReactTestRenderer | undefined;
  let fallback: unknown;
  try {
    await act(async () => {
      renderer = create(
        <StreamPanel
          device={{
            id: "phone",
            name: "Phone",
            platform: "ios",
            version: "26",
            booted: true,
            physical: false,
            supported: true,
            deviceFrame: null,
          }}
          client={
            {
              status: "streaming",
              screen: { width: 375, height: 667 },
              capabilities: { clipboard: true },
              clipboardPending: null,
              copyText: async () => "device text",
              deviceSettings: {},
              deviceSettingsPending: new Set(),
            } as unknown as DeviceClient
          }
          DeviceScreen={() => null}
          displayScreen={(screen) => screen ?? null}
          onClipboardFallback={(request) => {
            fallback = request;
          }}
        />,
      );
    });
    await act(async () => {
      renderer!.root.findByProps({ "aria-label": "Full screen" }).props.onClick();
    });
    expect(renderer!.root.findByType("section").props.style.position).toBe("fixed");
    await act(async () => {
      await renderer!.root.findByType(PhoneFrame).props.onCopy();
    });
    expect(fallback).toEqual({ action: "copy", text: "device text" });
    expect(renderer!.root.findByType("section").props.style.position).toBe("relative");
    expect(renderer!.root.findByProps({ "aria-label": "Full screen" })).toBeDefined();
  } finally {
    if (renderer) await act(async () => renderer!.unmount());
    shown.mockRestore();
    restoreGlobals();
  }
});
