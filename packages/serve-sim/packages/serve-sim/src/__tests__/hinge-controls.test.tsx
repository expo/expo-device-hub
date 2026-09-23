import { describe, expect, test } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";
import { HingeControls } from "../client/components/hinge-controls";

const onChange = () => {};

describe("foldable simulator toolbar", () => {
  test("renders no controls without hinge capability", () => {
    expect(renderToStaticMarkup(<HingeControls onChange={onChange} />)).toBe("");
  });

  test("offers only the three basic poses in folding order", () => {
    const html = renderToStaticMarkup(<HingeControls supported onChange={onChange} />);
    const buttonLabels = [...html.matchAll(/<button[^>]*aria-label="([^"]+)"/g)].map((match) => match[1]);
    expect(buttonLabels).toEqual(["Fully folded", "Partially open", "Fully open"]);
    expect(html).not.toContain('aria-pressed="true"');
    expect(html).not.toContain("<input");
    expect(html).not.toContain("<select");
    expect(html).not.toContain("Table Mode");
    expect(html).not.toContain("Laptop");
    expect(html).not.toContain("Tent");
    expect(html).not.toContain("Fine hinge adjustment");
  });

  test("uses the landscape icon for Partially open", () => {
    const html = renderToStaticMarkup(<HingeControls supported onChange={onChange} />);
    expect(html).toContain(encodeURIComponent("Half Fold — Landscape"));
    expect(html).not.toContain(encodeURIComponent("Half Fold — Portrait"));
  });

  test("hides unsupported controls even if old media retains an angle", () => {
    expect(renderToStaticMarkup(<HingeControls supported={false} angle={90} onChange={onChange} />)).toBe("");
  });

  test("identifies and enables both folding endpoints", () => {
    for (const [angle, label] of [[0, "Fully folded"], [180, "Fully open"]] as const) {
      const html = renderToStaticMarkup(<HingeControls angle={angle} onChange={onChange} />);
      expect(html).toContain('aria-label="Fold position"');
      expect(html).toMatch(new RegExp(`aria-label="${label}"[^>]*aria-pressed="true"`));
      expect(html).not.toMatch(/<button[^>]* disabled=""/);
    }
  });

  test("selects Partially open only for the book preset", () => {
    const book = renderToStaticMarkup(<HingeControls angle={90} pose="book" onChange={onChange} />);
    expect(book.match(/aria-pressed="true"/g)).toHaveLength(1);
    expect(book).toMatch(/aria-label="Partially open"[^>]*aria-pressed="true"/);
    for (const pose of [undefined, "laptop", "tent"] as const) {
      const html = renderToStaticMarkup(<HingeControls angle={90} pose={pose} onChange={onChange} />);
      expect(html).not.toContain('aria-pressed="true"');
    }
  });

  test("does not infer a preset when the simulator explicitly reports a custom pose", () => {
    for (const angle of [0, 180]) {
      const html = renderToStaticMarkup(<HingeControls angle={angle} pose={null} onChange={onChange} />);
      expect(html).not.toContain('aria-pressed="true"');
    }
  });

  test("keeps the presets available while a previous update is pending", () => {
    const html = renderToStaticMarkup(<HingeControls angle={90} pending onChange={onChange} />);
    expect(html).toContain('aria-busy="true"');
    expect(html).not.toContain("disabled");
  });

  test("announces control errors", () => {
    const html = renderToStaticMarkup(<HingeControls supported error="Could not change hinge angle" onChange={onChange} />);
    expect(html).toContain('role="alert"');
    expect(html).toContain("Could not change hinge angle");
  });
});
