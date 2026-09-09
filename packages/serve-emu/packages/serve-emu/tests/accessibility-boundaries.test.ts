import { describe, expect, test } from "bun:test";
import {
  findAccessibilityNode,
  parseAccessibilitySelector,
  parseAccessibilityXml,
  type AccessibilityNode,
} from "../src/accessibility.ts";

const node: AccessibilityNode = {
  id: "7",
  text: "Continue now",
  contentDescription: "Checkout & pay",
  resourceId: "com.example:id/continue",
  className: "android.widget.Button",
  packageName: "com.example",
  clickable: true,
  enabled: false,
  bounds: { left: 10, top: 20, right: 210, bottom: 80 },
};

describe("accessibility selector boundaries", () => {
  test("trims and retains every supported matcher", () => {
    expect(
      parseAccessibilitySelector({
        id: " 7 ",
        text: " Continue now ",
        textContains: " now ",
        contentDescription: " Checkout & pay ",
        contentDescriptionContains: " & pay ",
        resourceId: " com.example:id/continue ",
        resourceIdContains: " id/cont ",
        className: " android.widget.Button ",
        packageName: " com.example ",
        clickable: true,
        enabled: false,
        index: 0,
      }),
    ).toEqual({
      id: "7",
      text: "Continue now",
      textContains: "now",
      contentDescription: "Checkout & pay",
      contentDescriptionContains: "& pay",
      resourceId: "com.example:id/continue",
      resourceIdContains: "id/cont",
      className: "android.widget.Button",
      packageName: "com.example",
      clickable: true,
      enabled: false,
      index: 0,
    });
  });

  test("rejects invalid selector containers and bounded field values", () => {
    for (const value of [null, [], "text", 1]) {
      expect(() => parseAccessibilitySelector(value)).toThrow(
        "selector must be an object",
      );
    }
    expect(() => parseAccessibilitySelector({ text: 1 })).toThrow(
      "text must be a string",
    );
    expect(() => parseAccessibilitySelector({ text: "   " })).toThrow(
      "text cannot be empty",
    );
    expect(() => parseAccessibilitySelector({ text: "🙂".repeat(129) })).toThrow(
      "text is too long",
    );
    expect(() => parseAccessibilitySelector({ clickable: 1 })).toThrow(
      "clickable must be a boolean",
    );
    expect(() => parseAccessibilitySelector({ enabled: "true" })).toThrow(
      "enabled must be a boolean",
    );
    for (const index of [-1, 1.5, 10_001, "0"]) {
      expect(() => parseAccessibilitySelector({ text: "x", index })).toThrow(
        "index must be a non-negative integer",
      );
    }
  });

  test("matches all exact, substring, and boolean fields together", () => {
    const selector = parseAccessibilitySelector({
      id: node.id,
      text: node.text,
      textContains: "nue n",
      contentDescription: node.contentDescription,
      contentDescriptionContains: "out &",
      resourceId: node.resourceId,
      resourceIdContains: "example:id",
      className: node.className,
      packageName: node.packageName,
      clickable: true,
      enabled: false,
    });
    expect(findAccessibilityNode([node], selector)).toBe(node);
  });

  test("rejects every mismatched selector field and out-of-range indexes", () => {
    const mismatches = [
      { id: "other" },
      { text: "other" },
      { textContains: "missing" },
      { contentDescription: "other" },
      { contentDescriptionContains: "missing" },
      { resourceId: "other" },
      { resourceIdContains: "missing" },
      { className: "other" },
      { packageName: "other" },
      { clickable: false },
      { enabled: true },
    ];
    for (const selector of mismatches) {
      expect(() => findAccessibilityNode([node], selector)).toThrow(
        "no accessibility node matched selector",
      );
    }
    expect(() => findAccessibilityNode([node], { textContains: "Continue", index: 1 })).toThrow(
      "index is out of range",
    );
  });
});

describe("uiautomator XML parsing", () => {
  test("decodes attributes and skips missing or empty bounds", () => {
    const xml = `<?xml version="1.0" encoding="UTF-8"?>
      <hierarchy>
        <node text="Continue &amp; pay" content-desc="Say &quot;yes&quot; &apos;now&apos; &lt;ok&gt;"
          resource-id="com.example:id/continue" class="android.widget.Button"
          package="com.example" clickable="true" enabled="false" bounds="[10,20][210,80]" />
        <node text="missing" bounds="" />
        <node text="zero-width" bounds="[10,10][10,20]" />
        <node text="zero-height" bounds="[10,10][20,10]" />
      </hierarchy>`;

    expect(parseAccessibilityXml(xml)).toEqual([
      {
        id: "0",
        text: "Continue & pay",
        contentDescription: `Say "yes" 'now' <ok>`,
        resourceId: "com.example:id/continue",
        className: "android.widget.Button",
        packageName: "com.example",
        clickable: true,
        enabled: false,
        bounds: { left: 10, top: 20, right: 210, bottom: 80 },
      },
    ]);
  });

  test("supplies empty defaults and stable IDs for valid nodes only", () => {
    const xml = `<hierarchy>
      <node bounds="[0,0][0,10]" />
      <node bounds="[0,0][10,10]" />
      <node text="second" clickable="false" enabled="true" bounds="[1,2][3,4]" />
    </hierarchy>`;

    expect(parseAccessibilityXml(xml)).toEqual([
      {
        id: "0",
        text: "",
        contentDescription: "",
        resourceId: "",
        className: "",
        packageName: "",
        clickable: false,
        enabled: false,
        bounds: { left: 0, top: 0, right: 10, bottom: 10 },
      },
      {
        id: "1",
        text: "second",
        contentDescription: "",
        resourceId: "",
        className: "",
        packageName: "",
        clickable: false,
        enabled: true,
        bounds: { left: 1, top: 2, right: 3, bottom: 4 },
      },
    ]);
  });
});
