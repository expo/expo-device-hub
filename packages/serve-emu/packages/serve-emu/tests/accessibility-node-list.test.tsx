import { describe, expect, test } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";
import {
  ACCESSIBILITY_OVERSCAN,
  ACCESSIBILITY_ROW_HEIGHT,
  ACCESSIBILITY_VIEWPORT_HEIGHT,
  AccessibilityNodeList,
} from "../src/ui/components/accessibility-node-list";
import type { AccessibilityNode } from "../src/ui/components/accessibility-panel";
import {
  getFixedNavigationIndex,
  getFixedRovingIndex,
  getFixedScrollTopForIndex,
  getFixedVirtualRange,
} from "../src/ui/lib/fixed-virtual-list";

function accessibilityNode(index: number): AccessibilityNode {
  return {
    id: String(index),
    text: `Node ${index}`,
    contentDescription: "",
    resourceId: `com.example:id/node_${index}`,
    className: "android.widget.Button",
    packageName: "com.example",
    clickable: true,
    enabled: true,
    bounds: { left: 0, top: index, right: 100, bottom: index + 40 },
  };
}

const rangeAt = (itemCount: number, scrollTop: number) =>
  getFixedVirtualRange({
    itemCount,
    scrollTop,
    rowHeight: ACCESSIBILITY_ROW_HEIGHT,
    viewportHeight: ACCESSIBILITY_VIEWPORT_HEIGHT,
    overscan: ACCESSIBILITY_OVERSCAN,
  });

describe("fixed accessibility list virtualization", () => {
  test("keeps top, middle, and bottom ranges bounded", () => {
    expect(rangeAt(50_000, 0)).toEqual({ start: 0, end: 9, totalHeight: 2_000_000 });
    expect(rangeAt(50_000, 800)).toEqual({ start: 17, end: 29, totalHeight: 2_000_000 });
    expect(rangeAt(50_000, Number.POSITIVE_INFINITY)).toEqual({
      start: 49_991,
      end: 50_000,
      totalHeight: 2_000_000,
    });
    expect(rangeAt(50_000, 2_000_000)).toEqual({
      start: 49_991,
      end: 50_000,
      totalHeight: 2_000_000,
    });
  });

  test("handles empty and short lists without adding phantom rows", () => {
    expect(rangeAt(0, 100)).toEqual({ start: 0, end: 0, totalHeight: 0 });
    expect(rangeAt(2, 100)).toEqual({ start: 0, end: 2, totalHeight: 80 });
  });

  test("rejects unusable fixed-row dimensions", () => {
    expect(() =>
      getFixedVirtualRange({
        itemCount: 1,
        scrollTop: 0,
        rowHeight: 0,
        viewportHeight: 220,
        overscan: 3,
      }),
    ).toThrow("must be positive");
  });

  test("maps every supported navigation key to a bounded row", () => {
    expect(getFixedNavigationIndex("ArrowDown", 4, 20, 5)).toBe(5);
    expect(getFixedNavigationIndex("ArrowUp", 4, 20, 5)).toBe(3);
    expect(getFixedNavigationIndex("Home", 12, 20, 5)).toBe(0);
    expect(getFixedNavigationIndex("End", 2, 20, 5)).toBe(19);
    expect(getFixedNavigationIndex("PageDown", 4, 20, 5)).toBe(9);
    expect(getFixedNavigationIndex("PageUp", 4, 20, 5)).toBe(0);
    expect(getFixedNavigationIndex("ArrowUp", 0, 20, 5)).toBe(0);
    expect(getFixedNavigationIndex("ArrowDown", 19, 20, 5)).toBe(19);
    expect(getFixedNavigationIndex("Enter", 4, 20, 5)).toBeNull();
  });

  test("keeps a roving tab stop inside a manually scrolled viewport", () => {
    const options = {
      itemCount: 50_000,
      scrollTop: 1_000,
      rowHeight: ACCESSIBILITY_ROW_HEIGHT,
      viewportHeight: ACCESSIBILITY_VIEWPORT_HEIGHT,
    };

    expect(getFixedRovingIndex({ ...options, preferredIndex: 0 })).toBe(25);
    expect(getFixedRovingIndex({ ...options, preferredIndex: 28 })).toBe(28);
  });

  test("mounts every keyboard target while traversing all 50k rows", () => {
    let focusedIndex = 0;
    let scrollTop = 0;
    let everyTargetWasMounted = true;

    for (let step = 1; step < 50_000; step += 1) {
      focusedIndex = getFixedNavigationIndex("ArrowDown", focusedIndex, 50_000, 5) ?? -1;
      scrollTop = getFixedScrollTopForIndex({
        index: focusedIndex,
        itemCount: 50_000,
        scrollTop,
        rowHeight: ACCESSIBILITY_ROW_HEIGHT,
        viewportHeight: ACCESSIBILITY_VIEWPORT_HEIGHT,
      });
      const range = rangeAt(50_000, scrollTop);
      if (focusedIndex < range.start || focusedIndex >= range.end) {
        everyTargetWasMounted = false;
        break;
      }
    }

    expect(everyTargetWasMounted).toBe(true);
    expect(focusedIndex).toBe(49_999);
    expect(scrollTop).toBe(1_999_780);

    const homeIndex = getFixedNavigationIndex("Home", focusedIndex, 50_000, 5);
    expect(homeIndex).toBe(0);
    expect(
      getFixedScrollTopForIndex({
        index: homeIndex ?? -1,
        itemCount: 50_000,
        scrollTop,
        rowHeight: ACCESSIBILITY_ROW_HEIGHT,
        viewportHeight: ACCESSIBILITY_VIEWPORT_HEIGHT,
      }),
    ).toBe(0);
  });

  test("renders only nine rows from a 50k-node snapshot", () => {
    const nodes = Array.from({ length: 50_000 }, (_, index) => accessibilityNode(index));
    const markup = renderToStaticMarkup(
      <AccessibilityNodeList
        nodes={nodes}
        highlightedId="3"
        onHighlight={() => {}}
        onTapNode={() => {}}
      />,
    );

    expect(markup.match(/class="ax-node-slot"/g)?.length).toBe(9);
    expect(markup.match(/class="ax-node(?: active)?"/g)?.length).toBe(9);
    expect(markup.match(/<button[^>]*tabindex="0"/g)?.length).toBe(1);
    expect(markup.match(/<button[^>]*tabindex="-1"/g)?.length).toBe(8);
    expect(markup).toContain('class="ax-node active"');
    expect(markup).toContain('aria-setsize="50000"');
    expect(markup).not.toContain("Node 49999");
    expect(markup.length).toBeLessThan(10_000);
  });

  test("keeps the empty snapshot affordance", () => {
    const markup = renderToStaticMarkup(
      <AccessibilityNodeList
        nodes={[]}
        highlightedId={null}
        onHighlight={() => {}}
        onTapNode={() => {}}
      />,
    );

    expect(markup).toContain("No accessibility nodes yet.");
    expect(markup).not.toContain("ax-list-window");
  });
});
