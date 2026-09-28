import { describe, expect, test } from "bun:test";
import { framePolicyBlocks, requestFramePermission, takeFramePermissionGrant } from "../client/utils/frame-permission";

type Frame = {
  posted: Array<{ message: unknown; targetOrigin: string }>;
  allow: (features: string[]) => void;
};

function withGlobals(values: Record<string, unknown>, run: () => void): void {
  const previous = new Map(Object.keys(values).map((name) => [name, Object.getOwnPropertyDescriptor(globalThis, name)]));
  for (const [name, value] of Object.entries(values)) {
    Object.defineProperty(globalThis, name, { value, configurable: true, writable: true });
  }
  try {
    run();
  } finally {
    for (const [name, descriptor] of previous) {
      if (descriptor) Object.defineProperty(globalThis, name, descriptor);
      else Reflect.deleteProperty(globalThis, name);
    }
  }
}

function withFrame(policy: "permissionsPolicy" | "featurePolicy" | null, allowed: string[], run: (frame: Frame) => void) {
  const posted: Frame["posted"] = [];
  const stored = new Map<string, string>();
  let features = allowed;
  const doc = policy ? { [policy]: { allowsFeature: (feature: string) => features.includes(feature) } } : {};
  const win = {
    parent: { postMessage: (message: unknown, targetOrigin: string) => posted.push({ message, targetOrigin }) },
    sessionStorage: {
      getItem: (key: string) => stored.get(key) ?? null,
      setItem: (key: string, value: string) => stored.set(key, value),
      removeItem: (key: string) => stored.delete(key),
    },
  };
  withGlobals({ window: win, document: doc }, () => run({ posted, allow: (next) => { features = next; } }));
}

describe("framePolicyBlocks", () => {
  test("reports a permission the embedding page did not grant", () => {
    withFrame("permissionsPolicy", ["clipboard-write"], () => {
      expect(framePolicyBlocks("clipboard-read")).toBe(true);
    });
  });

  test("reads the older featurePolicy API", () => {
    withFrame("featurePolicy", ["clipboard-write"], () => {
      expect(framePolicyBlocks("clipboard-read")).toBe(true);
    });
  });

  test("passes a permission the embedding page granted", () => {
    withFrame("permissionsPolicy", ["clipboard-read"], () => {
      expect(framePolicyBlocks("clipboard-read")).toBe(false);
    });
  });

  test("passes a page that is not framed", () => {
    const self: { parent?: unknown } = {};
    self.parent = self;
    withGlobals({ window: self, document: {} }, () => {
      expect(framePolicyBlocks("clipboard-read")).toBe(false);
    });
  });

  test("does not guess when the browser has no policy API", () => {
    withFrame(null, [], () => {
      expect(framePolicyBlocks("camera")).toBe(false);
    });
  });
});

describe("frame permission requests", () => {
  test("asks the embedding page each time, so a closed prompt can come back", () => {
    withFrame("permissionsPolicy", [], (frame) => {
      requestFramePermission("clipboard-read");
      requestFramePermission("clipboard-read");
      const request = { type: "serve-sim:permission-request", permission: "clipboard-read" };
      expect(frame.posted).toEqual([
        { message: request, targetOrigin: "*" },
        { message: request, targetOrigin: "*" },
      ]);
    });
  });

  test("reports a grant once, after the page that asked is loaded with it", () => {
    withFrame("permissionsPolicy", [], (frame) => {
      expect(takeFramePermissionGrant("clipboard-read")).toBe(false);

      requestFramePermission("clipboard-read");
      expect(takeFramePermissionGrant("clipboard-read")).toBe(false);

      frame.allow(["clipboard-read"]);
      expect(takeFramePermissionGrant("camera")).toBe(false);
      expect(takeFramePermissionGrant("clipboard-read")).toBe(true);
      expect(takeFramePermissionGrant("clipboard-read")).toBe(false);
    });
  });
});
