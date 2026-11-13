import { expect, test } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";

import { type Device } from "../dashboard/data";
import { DeviceOptionsSection } from "../dashboard/DeviceOptionsSection";
import { LogSidebar } from "../dashboard/LogSidebar";

const ROW = /Rendering<\/span><\/span><span[^>]*>(CPU|GPU)<\/span>/;

function device(overrides: Partial<Device>): Device {
  return {
    id: "emulator-5554",
    name: "Medium Phone",
    version: "16",
    platform: "android",
    physical: false,
    booted: true,
    supported: true,
    ...overrides,
  };
}

test.each([
  ["cpu", "CPU"],
  ["gpu", "GPU"],
] as const)("shows a read-only Rendering row for %s rendering", (rendering, value) => {
  const html = renderToStaticMarkup(<DeviceOptionsSection rendering={rendering} />);
  expect(html.match(ROW)?.[1]).toBe(value);
  // A plain value, not a control, and no renderer name.
  const start = html.indexOf(">Rendering<");
  const row = html.slice(start, html.indexOf("</div>", start));
  expect(row).not.toMatch(/<(button|select|input)/);
  expect(html).not.toMatch(/swiftshader|lavapipe|llvmpipe/i);
});

test("hides the row where the renderer is not read", () => {
  expect(renderToStaticMarkup(<DeviceOptionsSection rendering={null} />)).not.toContain(
    "Rendering",
  );
  expect(renderToStaticMarkup(<DeviceOptionsSection />)).not.toContain("Rendering");
});

test.each([
  ["an emulator", device({}), true],
  ["a physical Android device", device({ id: "R5CT1234", physical: true }), false],
  ["a simulator", device({ id: "UDID", platform: "ios" }), false],
])("shows the row in the inspector only for %s", (_case, selected, visible) => {
  const html = renderToStaticMarkup(<LogSidebar device={selected} rendering="cpu" />);
  expect(ROW.test(html)).toBe(visible);
});
