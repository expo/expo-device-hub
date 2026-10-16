import { describe, expect, test } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";
import { StreamStatusPill } from "../client/components/stream-status-pill";

describe("StreamStatusPill", () => {
  test("reports a keyboard-only failure without claiming touch is unavailable", () => {
    const html = renderToStaticMarkup(<StreamStatusPill streaming keyboardUnavailable />);
    expect(html).toContain(">keyboard unavailable</span>");
    expect(html).toContain("Touch input remains available.");
  });
  test.each([true, false])("shows input failure when streaming is %s", (streaming) => {
    const html = renderToStaticMarkup(<StreamStatusPill streaming={streaming} inputUnavailable />);

    expect(html).toContain(">input unavailable</span>");
    expect(html).toContain("Touch and keyboard input are unavailable. Restart serve-sim to retry.");
    expect(html).not.toContain(">live</span>");
  });

  test("renders live state", () => {
    const html = renderToStaticMarkup(<StreamStatusPill streaming />);

    expect(html).toContain('data-testid="stream-status-pill"');
    expect(html).toContain(">live</span>");
    expect(html).not.toContain("connecting");
  });

  test("renders connecting state", () => {
    const html = renderToStaticMarkup(<StreamStatusPill streaming={false} />);

    expect(html).toContain("connecting");
    expect(html).not.toContain(">live</span>");
  });
});
