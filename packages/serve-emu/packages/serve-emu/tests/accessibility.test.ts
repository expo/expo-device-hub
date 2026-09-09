import { describe, expect, test } from "bun:test";
import {
  findAccessibilityNode,
  parseAccessibilitySelector,
  type AccessibilityNode,
} from "../src/accessibility.ts";

const nodes: AccessibilityNode[] = [
  {
    id: "0",
    text: "Email",
    contentDescription: "",
    resourceId: "com.example:id/email",
    className: "android.widget.EditText",
    packageName: "com.example",
    clickable: true,
    enabled: true,
    bounds: { left: 10, top: 20, right: 210, bottom: 80 },
  },
  {
    id: "1",
    text: "Continue",
    contentDescription: "",
    resourceId: "com.example:id/continue",
    className: "android.widget.Button",
    packageName: "com.example",
    clickable: true,
    enabled: true,
    bounds: { left: 10, top: 100, right: 210, bottom: 160 },
  },
  {
    id: "2",
    text: "Continue",
    contentDescription: "",
    resourceId: "",
    className: "android.widget.TextView",
    packageName: "com.example",
    clickable: false,
    enabled: true,
    bounds: { left: 10, top: 180, right: 210, bottom: 240 },
  },
];

describe("parseAccessibilitySelector", () => {
  test("accepts bounded selector fields", () => {
    expect(parseAccessibilitySelector({ textContains: "Cont", clickable: true })).toEqual({
      textContains: "Cont",
      clickable: true,
    });
  });

  test("requires at least one matcher", () => {
    expect(() => parseAccessibilitySelector({ index: 0 })).toThrow("at least one matcher");
  });
});

describe("findAccessibilityNode", () => {
  test("finds a unique node by resource id", () => {
    expect(findAccessibilityNode(nodes, { resourceId: "com.example:id/email" }).id).toBe("0");
  });

  test("requires index for ambiguous selectors", () => {
    expect(() => findAccessibilityNode(nodes, { text: "Continue" })).toThrow("provide index");
    expect(findAccessibilityNode(nodes, { text: "Continue", index: 1 }).id).toBe("2");
  });

  test("can narrow matches with booleans", () => {
    expect(findAccessibilityNode(nodes, { text: "Continue", clickable: true }).id).toBe("1");
  });
});
