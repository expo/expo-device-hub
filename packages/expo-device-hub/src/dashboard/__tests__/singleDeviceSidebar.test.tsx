import { afterEach, describe, expect, test } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";

import { useDashboardStore } from "../dashboardStore";
import { useSidebarLayout } from "../useSidebarLayout";

type SidebarLayoutResult = ReturnType<typeof useSidebarLayout>;

function renderSidebarLayout(): SidebarLayoutResult {
  let result: SidebarLayoutResult | undefined;
  function Probe() {
    result = useSidebarLayout({ leftWidth: 320, rightWidth: 0, minStreamWidth: 320 });
    return null;
  }
  renderToStaticMarkup(<Probe />);
  return result!;
}

afterEach(() => {
  delete (globalThis as any).window;
  useDashboardStore.setState({ sidebarPreferences: { left: "auto", right: "auto" } });
});

// The left sidebar holds the device inspector, so a locked session must keep it.
describe("single-device sidebar", () => {
  test("docks the left sidebar when it fits", () => {
    (globalThis as any).window = { innerWidth: 1440, __EXPO_DEVICE_HUB_SINGLE_DEVICE__: "pinned" };
    expect(renderSidebarLayout()).toMatchObject({ leftOpen: true, leftDocked: true });
  });

  test("reopens the left sidebar from its toggle", () => {
    (globalThis as any).window = { innerWidth: 1440, __EXPO_DEVICE_HUB_SINGLE_DEVICE__: "pinned" };
    useDashboardStore.getState().closeSidebar("left");
    renderSidebarLayout().openLeft();
    expect(useDashboardStore.getState().sidebarPreferences.left).toBe("auto");
  });
});
