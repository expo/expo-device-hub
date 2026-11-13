import { afterEach, beforeEach, describe, expect, spyOn, test } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";
import { act, create, type ReactTestRenderer } from "react-test-renderer";
import {
  AppDetectionSkeleton,
  AppDetectionTool,
  AppIcon,
  AppIconFallback,
  AppSummaryLabel,
  isSystemBundleId,
} from "../client/components/app-detection-tool";
import { fetchAppDetails } from "../client/utils/app-icon";
import * as clientControl from "../socket/client-control";

describe("Home screen", () => {
  test("shows install guidance instead of app metadata loading", () => {
    const html = renderToStaticMarkup(
      <AppDetectionTool
        udid="test-device"
        currentApp={{ bundleId: "com.apple.springboard", isReactNative: false }}
      />,
    );
    expect(html).toContain("Home screen");
    expect(html).toContain("Install and open your app to see it here.");
    expect(html).not.toContain("app-detection-skeleton");
    expect(html).not.toContain("Version");
  });

  test("does not request an app container for SpringBoard", async () => {
    expect(await fetchAppDetails("test-device", "com.apple.springboard")).toEqual({
      displayName: "Home screen",
    });
  });
});

describe("AppDetectionTool metadata", () => {
  let renderer: ReactTestRenderer | undefined;
  let previousAct: unknown;
  let restoreHostAction: (() => void) | undefined;

  beforeEach(() => {
    previousAct = Reflect.get(globalThis, "IS_REACT_ACT_ENVIRONMENT");
    Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
  });

  afterEach(async () => {
    try {
      await act(async () => renderer?.unmount());
    } finally {
      renderer = undefined;
      restoreHostAction?.();
      restoreHostAction = undefined;
      Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: previousAct });
    }
  });

  test("settles an unknown app and recovers when the home screen is detected", async () => {
    await act(async () => {
      renderer = create(<AppDetectionTool udid="test-device" currentApp={null} />);
    });
    expect(renderer!.root.findAllByProps({ "data-testid": "app-detection-skeleton" })).toHaveLength(
      1,
    );

    await act(async () => {
      await Bun.sleep(1550);
    });
    expect(renderer!.root.findAllByProps({ "data-testid": "app-detection-skeleton" })).toHaveLength(
      0,
    );
    expect(
      renderer!.root.findAll((node) => node.children.includes("App details unavailable")),
    ).toHaveLength(1);

    await act(async () => {
      renderer!.update(
        <AppDetectionTool
          udid="test-device"
          currentApp={{ bundleId: "com.apple.springboard", isReactNative: false }}
        />,
      );
    });
    expect(renderer!.root.findAll((node) => node.children.includes("Home screen"))).toHaveLength(1);
    expect(renderer!.root.findByType("p").children).toContain(
      "Install and open your app to see it here.",
    );
  });

  test("settles a rejected metadata request and exposes the error in the collapsed summary", async () => {
    const request = spyOn(clientControl, "runHostAction").mockRejectedValue(
      new Error("control channel disconnected"),
    );
    restoreHostAction = () => request.mockRestore();
    await act(async () => {
      renderer = create(
        <AppDetectionTool
          udid="test-device"
          currentApp={{ bundleId: "com.example.app", isReactNative: false }}
        />,
      );
    });

    const section = renderer!.root.findByType("details");
    expect(section.props.open).toBe(false);
    expect(
      section
        .findByType("summary")
        .findAll((node) => node.children.includes("Couldn't load app details")),
    ).toHaveLength(1);
    expect(
      section.findAll((node) => node.children.includes("control channel disconnected")),
    ).toHaveLength(1);
    expect(section.findAll((node) => node.children.includes("…"))).toHaveLength(0);
  });

  test("does not replace a new app's details when the previous lookup rejects", async () => {
    let rejectPrevious!: (error: Error) => void;
    const previousLookup = new Promise<Awaited<ReturnType<typeof clientControl.runHostAction>>>(
      (_resolve, reject) => {
        rejectPrevious = reject;
      },
    );
    let containers = 0;
    const request = spyOn(clientControl, "runHostAction").mockImplementation(async (action) => {
      if (action === "app.container") {
        if (containers++ === 0) return previousLookup;
        return { stdout: "/tmp/Next.app", stderr: "", exitCode: 0 };
      }
      if (action === "app.infoPlist") {
        return {
          stdout: JSON.stringify({ CFBundleDisplayName: "Next app" }),
          stderr: "",
          exitCode: 0,
        };
      }
      throw new Error(`Unexpected host action: ${action}`);
    });
    restoreHostAction = () => request.mockRestore();
    await act(async () => {
      renderer = create(
        <AppDetectionTool
          udid="test-device"
          currentApp={{ bundleId: "com.example.previous", isReactNative: false }}
        />,
      );
    });
    await act(async () => {
      renderer!.update(
        <AppDetectionTool
          udid="test-device"
          currentApp={{ bundleId: "com.example.next", isReactNative: false }}
        />,
      );
    });
    await act(async () => {
      rejectPrevious(new Error("previous lookup disconnected"));
    });
    const summary = renderer!.root.findByType("summary");
    expect(summary.findAll((node) => node.children.includes("Next app"))).toHaveLength(1);
    expect(
      summary.findAll((node) => node.children.includes("Couldn't load app details")),
    ).toHaveLength(0);
  });

  test("retries failed metadata when app state refreshes with the same identity", async () => {
    let containers = 0;
    const request = spyOn(clientControl, "runHostAction").mockImplementation(async (action) => {
      if (action === "app.container") {
        if (containers++ === 0) throw new Error("control channel disconnected");
        return { stdout: "/tmp/Recovered.app", stderr: "", exitCode: 0 };
      }
      if (action === "app.infoPlist") {
        return {
          stdout: JSON.stringify({ CFBundleDisplayName: "Recovered app" }),
          stderr: "",
          exitCode: 0,
        };
      }
      throw new Error(`Unexpected host action: ${action}`);
    });
    restoreHostAction = () => request.mockRestore();
    const identity = { bundleId: "com.example.app", isReactNative: false, pid: 123 };
    await act(async () => {
      renderer = create(<AppDetectionTool udid="test-device" currentApp={identity} />);
    });
    expect(
      renderer!.root
        .findByType("summary")
        .findAll((node) => node.children.includes("Couldn't load app details")),
    ).toHaveLength(1);
    await act(async () => {
      renderer!.update(<AppDetectionTool udid="test-device" currentApp={{ ...identity }} />);
    });
    const summary = renderer!.root.findByType("summary");
    expect(summary.findAll((node) => node.children.includes("Recovered app"))).toHaveLength(1);
    expect(
      summary.findAll((node) => node.children.includes("Couldn't load app details")),
    ).toHaveLength(0);
  });
});

describe("AppDetectionTool app icon fallback", () => {
  test("recognizes Apple system bundle ids", () => {
    expect(isSystemBundleId("com.apple.springboard")).toBe(true);
    expect(isSystemBundleId("com.example.app")).toBe(false);
  });

  test("renders a system-app treatment instead of an empty square", () => {
    const html = renderToStaticMarkup(<AppIconFallback bundleId="com.apple.springboard" />);

    expect(html).toContain('data-testid="system-app-icon"');
    expect(html).toContain("System app");
    expect(html).toContain('role="img"');
    expect(html).toContain("<title>Apple</title>");
    expect(html).toContain("M12.152 6.896c-.948");
  });

  test("uses official icon data even for Apple system apps", () => {
    const html = renderToStaticMarkup(
      <AppIcon bundleId="com.apple.Preferences" iconDataUrl="data:image/png;base64,settings" />,
    );

    expect(html).toContain("<img");
    expect(html).toContain('src="data:image/png;base64,settings"');
    expect(html).not.toContain('data-testid="system-app-icon"');
    expect(html).not.toContain("<title>Apple</title>");
  });
});

describe("AppSummaryLabel", () => {
  test("renders app identity without a summary-level loading spinner", () => {
    const html = renderToStaticMarkup(
      <AppSummaryLabel bundleId="com.apple.springboard" displayName="SpringBoard" />,
    );

    expect(html).toContain("text-left");
    expect(html).toContain("SpringBoard");
    expect(html).toContain("com.apple.springboard");
    expect(html).not.toContain('data-testid="app-summary-loading"');
    expect(html).not.toContain("animate-[grid-spin");
    expect(html).not.toContain("SpringBoard …");
  });
});

describe("AppDetectionSkeleton", () => {
  test("uses the app summary footprint without dashed waiting text", () => {
    const html = renderToStaticMarkup(<AppDetectionSkeleton />);

    expect(html).toContain('data-testid="app-detection-skeleton"');
    expect(html).toContain("bg-panel rounded-[10px] px-3 py-2");
    expect(html).toContain("min-h-[36px]");
    expect(html).not.toContain("border-dashed");
    expect(html).not.toContain("Waiting for an app");
  });
});
