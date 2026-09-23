import { describe, expect, test } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";
import { PresentationExitButton } from "../client/components/presentation-exit-button";

describe("PresentationExitButton", () => {
  const html = renderToStaticMarkup(<PresentationExitButton onClick={() => {}} />);

  test("is a real button, not a clickable div", () => {
    expect(html).toContain('<button type="button"');
  });

  test("names the action and its keyboard shortcut", () => {
    expect(html).toContain('aria-label="Exit full screen"');
    expect(html).toContain('title="Exit full screen (Esc)"');
  });
});
