import { beforeEach, describe, expect, mock, test } from "bun:test";

const actions: Array<{ action: string; params: Record<string, unknown> }> = [];
void mock.module("../client/utils/exec", () => ({
  runHostAction: async (action: string, params: Record<string, unknown> = {}) => {
    actions.push({ action, params });
    return { stdout: "", stderr: "", exitCode: 0 };
  },
}));

beforeEach(() => {
  actions.length = 0;
});
import { renderToStaticMarkup } from "react-dom/server";
import { SimulatorToolbar, pressHomeAsync } from "../client/simulator/SimulatorToolbar";


describe("SimulatorToolbar.Title", () => {
  test("can hide the runtime subtitle", () => {
    const html = renderToStaticMarkup(
      <SimulatorToolbar
        deviceUdid="booted"
        deviceName="iPhone 16 (26.5)"
        deviceRuntime="iOS-26-5"
        streaming
      >
        <SimulatorToolbar.Title hideSubtitle />
      </SimulatorToolbar>,
    );

    expect(html).toContain("iPhone 16 (26.5)");
    expect(html).not.toContain("iOS-26-5");
  });

  test("can hide the chevron", () => {
    const html = renderToStaticMarkup(
      <SimulatorToolbar
        deviceUdid="booted"
        deviceName="iPhone 16 (26.5)"
        streaming
      >
        <SimulatorToolbar.Title hideChevron />
      </SimulatorToolbar>,
    );

    expect(html).toContain("iPhone 16 (26.5)");
    expect(html).not.toContain("<polyline");
  });
});

describe("pressHomeAsync", () => {
  // Xcode 26+ silently drops the HID home press, so phones/pads must relaunch
  // SpringBoard instead of going through `serve-sim button home`.
  test("relaunches SpringBoard for a known iphone udid", async () => {
    await pressHomeAsync("iphone", "BOOTED-UDID");
    expect(actions.at(-1)).toEqual({
      action: "home.springboard",
      params: { udid: "BOOTED-UDID" },
    });
  });

  test("relaunches SpringBoard for ipad simulators", async () => {
    await pressHomeAsync("ipad", "udid");
    expect(actions.at(-1)?.action).toBe("home.springboard");
  });

  test("drives Simulator.app's Device > Home menu for watch simulators", async () => {
    await pressHomeAsync("watch", "udid");
    expect(actions.at(-1)?.action).toBe("home.watch");
  });

  test("falls back to the HID button action when no udid is known", async () => {
    await pressHomeAsync("iphone", null);
    expect(actions.at(-1)).toEqual({ action: "button", params: { value: "home" } });
  });
});

describe("SimulatorToolbar.Button", () => {
  test("uses the shared panel background variable", () => {
    const html = renderToStaticMarkup(
      <SimulatorToolbar deviceUdid="booted" streaming>
        <SimulatorToolbar.Button aria-label="Capture">icon</SimulatorToolbar.Button>
      </SimulatorToolbar>,
    );

    expect(html).toContain("background:var(--serve-sim-panel-bg, #181818)");
  });

  test("uses a rounded hover surface for icon actions", () => {
    const html = renderToStaticMarkup(
      <SimulatorToolbar deviceUdid="booted" streaming>
        <SimulatorToolbar.Button aria-label="Capture">icon</SimulatorToolbar.Button>
      </SimulatorToolbar>,
    );

    expect(html).toContain("border-radius:12px");
  });

  test("renders a tooltip from the aria label", () => {
    const html = renderToStaticMarkup(
      <SimulatorToolbar deviceUdid="booted" streaming>
        <SimulatorToolbar.HomeButton />
      </SimulatorToolbar>,
    );

    expect(html).toContain('role="tooltip"');
    expect(html).toContain(">Home</span>");
  });

  test("uses title text for the tooltip without relying on native title", () => {
    const html = renderToStaticMarkup(
      <SimulatorToolbar deviceUdid="booted" streaming>
        <SimulatorToolbar.Button aria-label="Capture" title="Screenshot">
          icon
        </SimulatorToolbar.Button>
      </SimulatorToolbar>,
    );

    expect(html).toContain('role="tooltip"');
    expect(html).toContain(">Screenshot</span>");
    expect(html).not.toContain('title="Screenshot"');
  });
});
