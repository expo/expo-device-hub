import { expect, test } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";

import { type Device } from "../dashboard/data";
import { DeviceOptionsSection } from "../dashboard/DeviceOptionsSection";
import { GPU_WARNING_TITLE } from "../dashboard/GpuWarning";
import { LogSidebar } from "../dashboard/LogSidebar";

function device(overrides: Partial<Device>): Device {
  return {
    id: "emulator-5554",
    name: "Pixel 9",
    version: "16",
    platform: "android",
    physical: false,
    booted: true,
    supported: true,
    ...overrides,
  };
}

test("tells the user to restart with -gpu host and names the software renderer", () => {
  const html = renderToStaticMarkup(
    <DeviceOptionsSection gpuWarning={{ renderer: "SwiftShader" }} />,
  );
  expect(html).toContain(GPU_WARNING_TITLE);
  expect(html).toContain("SwiftShader");
  expect(html).toContain("-gpu host</code>");
  expect(html).toContain('role="status"');
});

test("shows no warning without one", () => {
  expect(renderToStaticMarkup(<DeviceOptionsSection gpuWarning={null} />)).not.toContain(
    GPU_WARNING_TITLE,
  );
  expect(renderToStaticMarkup(<DeviceOptionsSection />)).not.toContain(GPU_WARNING_TITLE);
});

test.each([
  ["an emulator", device({}), true],
  ["a physical Android device", device({ id: "R5CT1234", physical: true }), false],
  ["a simulator", device({ id: "UDID", platform: "ios" }), false],
])("shows the warning in the inspector only for %s", (_case, selected, visible) => {
  const html = renderToStaticMarkup(
    <LogSidebar device={selected} gpuWarning={{ renderer: "SwiftShader" }} />,
  );
  expect(html.includes(GPU_WARNING_TITLE)).toBe(visible);
});
