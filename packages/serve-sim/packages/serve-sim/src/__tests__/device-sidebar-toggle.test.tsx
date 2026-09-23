import { describe, expect, test } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";
import { DeviceSidebarToggle } from "../client/components/device-sidebar-toggle";
import { EAS_SIMULATOR_URL } from "../client/components/serve-sim-brand-link";

const noop = () => {};

describe("DeviceSidebarToggle", () => {
  test("keeps EAS Simulator branding under the collapsed sidebar position", () => {
    const html = renderToStaticMarkup(<DeviceSidebarToggle open={false} onClick={noop} />);

    expect(html).toContain("top-3");
    expect(html).toContain("left-3");
    expect(html).toContain("z-30");
    expect(html).toContain("flex items-center");
    expect(html).toContain("EAS Simulator");
    expect(html).toContain("text-white/65");
    expect(html).toContain(`href="${EAS_SIMULATOR_URL}"`);
    expect(html).not.toContain("max-[900px]:hidden");
  });
});
