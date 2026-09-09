import { describe, expect, test } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";
import { ToolSection } from "../src/ui/components/tool-section";

describe("ToolSection", () => {
  test("keeps collapsed panel code out of the React tree", () => {
    let panelRenders = 0;
    const Probe = () => {
      panelRenders += 1;
      return <div>device-backed panel</div>;
    };

    const markup = renderToStaticMarkup(
      <ToolSection id="network-tool" title="Network">
        <Probe />
      </ToolSection>,
    );

    expect(panelRenders).toBe(0);
    expect(markup).toContain('aria-expanded="false"');
    expect(markup).toContain('aria-controls="network-tool-body"');
    expect(markup).toContain('id="network-tool-body"');
    expect(markup).toContain("hidden");
    expect(markup).not.toContain("device-backed panel");
  });

  test("mounts an explicitly expanded panel behind its disclosure control", () => {
    let panelRenders = 0;
    const Probe = () => {
      panelRenders += 1;
      return <div>device-backed panel</div>;
    };

    const markup = renderToStaticMarkup(
      <ToolSection id="location-tool" title="Location" defaultExpanded>
        <Probe />
      </ToolSection>,
    );

    expect(panelRenders).toBe(1);
    expect(markup).toContain('aria-expanded="true"');
    expect(markup).toContain('aria-controls="location-tool-body"');
    expect(markup).toContain('id="location-tool-body"');
    expect(markup).toContain("device-backed panel");
    expect(markup).not.toContain('id="location-tool-body" class="tool-section-body" hidden');
  });
});
