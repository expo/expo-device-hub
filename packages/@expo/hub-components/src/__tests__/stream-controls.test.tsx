import { describe, expect, test } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";

import { type DeviceClient, type DeviceScreenProps } from "@expo/hub-client";
import { type Device } from "../dashboard/data";
import { StreamControls } from "../dashboard/StreamControls";
import { StreamPanel } from "../dashboard/StreamPanel";

function buttonTags(markup: string) {
  return [...markup.matchAll(/<button[^>]*>/g)].map((match) => match[0]);
}

const labels = (markup: string) =>
  buttonTags(markup).map((tag) => tag.match(/aria-label="([^"]+)"/)?.[1]);

describe("StreamControls", () => {
  test.each([
    ["recording-status-unknown", "Rotation is unavailable until recording status is known."],
    ["recording", "Rotation is unavailable while recording."],
    ["input-unavailable", "Rotation is unavailable until the simulator accepts input."],
  ] as const)(
    "locks Rotate while orientation is unavailable for %s, without disabling app controls",
    (orientationUnavailable, reason) => {
      const markup = renderToStaticMarkup(
        <StreamControls onRotate={() => {}} orientationUnavailable={orientationUnavailable} />,
      );
      const buttons = buttonTags(markup);
      const rotate = buttons.find((tag) => tag.includes('aria-label="Rotate device"'));
      expect(rotate).toContain('aria-disabled="true"');
      expect(rotate).toContain(`aria-description="${reason}"`);
      // A locked control is dimmed like the website's disabled controls.
      expect(rotate).toContain("opacity:0.4");
      for (const tag of buttons.filter((tag) => !tag.includes('aria-label="Rotate device"'))) {
        expect(tag).not.toContain("disabled");
        expect(tag).toContain("opacity:1");
      }
    },
  );
  test("leaves Rotate enabled while orientation is available", () => {
    const markup = renderToStaticMarkup(
      <StreamControls onRotate={() => {}} orientationUnavailable={null} />,
    );
    const rotate = buttonTags(markup).find((tag) => tag.includes('aria-label="Rotate device"'));
    expect(rotate).not.toContain("aria-disabled");
    expect(rotate).not.toContain("Rotation is unavailable");
  });
  test("puts every control in one bar and names it by what it does", () => {
    const markup = renderToStaticMarkup(<StreamControls orientationUnavailable={null} />);

    expect(labels(markup)).toEqual([
      "Go to home screen",
      "Take screenshot",
      "Reload app",
      "Rotate device",
    ]);
    expect(markup).not.toContain("More");
    expect(markup).not.toContain("Shutdown");
    expect(markup).not.toContain("Remove");

    // One bar holds all buttons: the toolbar element itself is the rounded surface.
    const bar = markup.match(/^<div role="toolbar" aria-label="Device controls" style="([^"]+)"/);
    expect(bar?.[1]).toContain("border-radius:var(--expo-radius-2xl)");
    expect(bar?.[1]).toContain("background-color:var(--expo-theme-background-element)");
    expect(bar?.[1]).toContain("gap:4px");
    expect(bar?.[1]).toContain("padding:8px");
    expect(bar?.[1]).toContain("flex-wrap:wrap");
    expect(markup.match(/<div /g)).toHaveLength(1);
  });

  test("leads an Android toolbar with its navigation buttons, in the order of its navigation bar", () => {
    const markup = renderToStaticMarkup(
      <StreamControls
        orientationUnavailable={null}
        onBack={() => {}}
        onRecents={() => {}}
        onDismissKeyboard={() => {}}
      />,
    );

    expect(labels(markup)).toEqual([
      "Go back",
      "Go to home screen",
      "Show recent apps",
      "Dismiss keyboard",
      "Take screenshot",
      "Reload app",
      "Rotate device",
    ]);
  });

  test("shows one Clipboard menu before Rotate when the device offers either action", () => {
    const toolbar = (clipboard: { paste: boolean; copy: boolean } | false) =>
      labels(
        renderToStaticMarkup(
          <StreamControls orientationUnavailable={null} clipboard={clipboard} />,
        ),
      );
    const base = ["Go to home screen", "Take screenshot", "Reload app"];

    expect(toolbar({ paste: true, copy: true })).toEqual([...base, "Clipboard", "Rotate device"]);
    expect(toolbar({ paste: true, copy: false })).toEqual([...base, "Clipboard", "Rotate device"]);
    expect(toolbar({ paste: false, copy: true })).toEqual([...base, "Clipboard", "Rotate device"]);
    expect(toolbar({ paste: false, copy: false })).toEqual([...base, "Rotate device"]);
    expect(toolbar(false)).toEqual([...base, "Rotate device"]);
  });

  test.each(["paste", "copy"] as const)(
    "disables the Clipboard menu and shows a spinner while %s is pending",
    (pending) => {
      const markup = renderToStaticMarkup(
        <StreamControls
          orientationUnavailable={null}
          clipboard={{ paste: true, copy: true }}
          clipboardPending={pending}
        />,
      );
      for (const tag of buttonTags(markup)) {
        if (tag.includes('aria-label="Clipboard"')) {
          expect(tag).toContain('disabled=""');
          expect(tag).toContain('aria-busy="true"');
          // A control that works on its action keeps full opacity, as on the website.
          expect(tag).toContain("opacity:1");
        } else {
          expect(tag).not.toContain("disabled");
          expect(tag).not.toContain("aria-busy");
        }
      }
      const clipboard = markup.slice(
        markup.indexOf('aria-label="Clipboard"'),
        markup.indexOf('aria-label="Rotate device"'),
      );
      expect(clipboard).toContain('role="status"');
    },
  );

  test("shows a spinner in Take screenshot while a screenshot is in flight", () => {
    const tag = (saving: boolean) =>
      buttonTags(
        renderToStaticMarkup(<StreamControls orientationUnavailable={null} saving={saving} />),
      ).find((button) => button.includes('aria-label="Take screenshot"'));

    expect(tag(false)).not.toContain("aria-busy");
    expect(tag(true)).toContain('aria-busy="true"');
    expect(tag(true)).toContain('aria-disabled="true"');
    expect(tag(true)).not.toContain('disabled=""');
  });

  test("keeps tooltips closed at rest, sizes every button alike, and exposes Keyboard as a switch", () => {
    const markup = renderToStaticMarkup(
      <StreamControls
        orientationUnavailable={null}
        keyboard={{ open: true, onToggle: () => {} }}
      />,
    );

    // The label is the accessible name. The tooltip repeats it only while the
    // pointer is over the button or it has keyboard focus, so no tooltip renders at rest.
    expect(markup).not.toContain('role="tooltip"');
    const keyboard = buttonTags(markup).find((tag) => tag.includes('aria-label="Keyboard"'));
    expect(keyboard).toContain('role="switch"');
    expect(keyboard).toContain('aria-checked="true"');
    for (const tag of buttonTags(markup)) {
      expect(tag).toContain('class="hub-pressable"');
      expect(tag).toContain("width:36px");
      expect(tag).toContain("height:36px");
      expect(tag).toContain("border-radius:var(--expo-radius-full)");
    }
  });

  describe("Keyboard toggle", () => {
    const keyboard = { open: false, onToggle: () => {} };

    test("sits after Clipboard and before Rotate", () => {
      const markup = renderToStaticMarkup(
        <StreamControls
          orientationUnavailable={null}
          clipboard={{ paste: true, copy: true }}
          keyboard={keyboard}
        />,
      );

      expect(labels(markup)).toEqual([
        "Go to home screen",
        "Take screenshot",
        "Reload app",
        "Clipboard",
        "Keyboard",
        "Rotate device",
      ]);
    });

    test("keeps its place when the device has no clipboard actions", () => {
      const markup = renderToStaticMarkup(
        <StreamControls orientationUnavailable={null} keyboard={keyboard} />,
      );

      expect(labels(markup)).toEqual([
        "Go to home screen",
        "Take screenshot",
        "Reload app",
        "Keyboard",
        "Rotate device",
      ]);
    });

    test("is absent unless the viewer passes it", () => {
      expect(
        labels(renderToStaticMarkup(<StreamControls orientationUnavailable={null} />)),
      ).not.toContain("Keyboard");
    });
  });
});

describe("StreamPanel", () => {
  test("locks Rotate from the client's orientationUnavailable, not from its status or recording", () => {
    const device: Device = {
      id: "android",
      name: "Pixel 9",
      version: "Android 16",
      platform: "android",
      booted: true,
      physical: false,
      supported: true,
    };
    const rotate = (overrides: Partial<DeviceClient>) =>
      buttonTags(
        renderToStaticMarkup(
          <StreamPanel
            device={device}
            client={
              {
                status: "reconnecting",
                capabilities: { clipboard: false },
                clipboardPending: null,
                screenRecording: "recording",
                recordingControlsLocked: true,
                orientationUnavailable: null,
                ...overrides,
              } as DeviceClient
            }
            DeviceScreen={() => null}
            displayScreen={() => null}
          />,
        ),
      ).find((tag) => tag.includes('aria-label="Rotate device"'));
    expect(rotate({})).not.toContain("aria-disabled");
    expect(rotate({ orientationUnavailable: "recording" })).toContain('aria-disabled="true"');
    expect(rotate({ orientationUnavailable: "input-unavailable" })).toContain(
      'aria-disabled="true"',
    );
  });

  test("offers the clipboard actions of its client and blocks Copy while an action is pending", async () => {
    let onCopy: DeviceScreenProps["onCopy"];
    let copies = 0;
    const device: Device = {
      id: "ios",
      name: "iPhone 17 Pro",
      version: "iOS 27.0",
      platform: "ios",
      booted: true,
      physical: false,
      supported: true,
    };
    const toolbar = (
      clipboard: DeviceClient["capabilities"]["clipboard"],
      clipboardPending: DeviceClient["clipboardPending"] = null,
    ) =>
      renderToStaticMarkup(
        <StreamPanel
          device={device}
          client={
            {
              status: "streaming",
              capabilities: { clipboard },
              clipboardPending,
              copyText: async () => {
                copies++;
                return "selected";
              },
            } as DeviceClient
          }
          DeviceScreen={(props) => {
            onCopy = props.onCopy;
            return null;
          }}
          displayScreen={() => null}
        />,
      );

    expect(toolbar({ paste: true, copy: false })).toContain('aria-label="Clipboard"');
    expect(toolbar(false)).not.toContain('aria-label="Clipboard"');
    for (const pending of ["paste", "copy"] as const) {
      const buttons = buttonTags(toolbar({ paste: true, copy: true }, pending));
      expect(buttons.find((tag) => tag.includes('aria-label="Clipboard"'))).toContain(
        'disabled=""',
      );
      await onCopy!();
      expect(copies).toBe(0);
    }
    const idle = buttonTags(toolbar({ paste: true, copy: true }));
    expect(idle.find((tag) => tag.includes('aria-label="Clipboard"'))).not.toContain("disabled");
    await onCopy!();
    expect(copies).toBe(1);
  });

  test("gives DeviceScreen the host clipboard handlers for Command+V and Command+C", async () => {
    const pastes: Array<string | undefined> = [];
    const pasteText = async (text?: string) => void pastes.push(text);
    let screenClient: DeviceScreenProps["client"] | undefined;
    let onCopy: DeviceScreenProps["onCopy"];
    renderToStaticMarkup(
      <StreamPanel
        device={{
          id: "ios",
          name: "iPhone 17 Pro",
          version: "iOS 27.0",
          platform: "ios",
          booted: true,
          physical: false,
          supported: true,
        }}
        client={
          {
            status: "streaming",
            capabilities: { clipboard: { paste: true, copy: false } },
            pasteText,
          } as unknown as DeviceClient
        }
        DeviceScreen={(props) => {
          screenClient = props.client;
          onCopy = props.onCopy;
          return null;
        }}
        displayScreen={() => null}
      />,
    );

    expect(onCopy).toBeFunction();
    expect(screenClient?.pasteText).toBeDefined();
    expect(screenClient?.pasteText).not.toBe(pasteText);
    await screenClient!.pasteText("typed");
    expect(pastes).toEqual(["typed"]);
  });
});
