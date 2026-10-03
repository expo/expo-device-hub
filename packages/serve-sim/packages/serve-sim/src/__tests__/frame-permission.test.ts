import { describe, expect, test } from "bun:test";
import { frameMayNeedPermissionAfterFailure, requestFramePermission, takeFramePermissionGrant } from "../client/utils/frame-permission";

type Frame = {
  posted: Array<{ message: unknown; targetOrigin: string }>;
  allow: (features: string[]) => void;
  setFramed: (framed: boolean) => void;
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
  const parent = win.parent;
  withGlobals({ window: win, document: doc }, () => run({
    posted,
    allow: (next) => { features = next; },
    setFramed: (framed) => { (win as { parent: unknown }).parent = framed ? parent : win; },
  }));
}

describe("frameMayNeedPermissionAfterFailure", () => {
  test("requests help after a failed read when the embedding page did not grant permission", () => {
    withFrame("permissionsPolicy", ["clipboard-write"], () => {
      expect(frameMayNeedPermissionAfterFailure("clipboard-read", true)).toBe(true);
    });
  });

  test("reads the older featurePolicy API", () => {
    withFrame("featurePolicy", ["clipboard-write"], () => {
      expect(frameMayNeedPermissionAfterFailure("clipboard-read", true)).toBe(true);
    });
  });

  test("does not request a grant for unrelated read failures when policy allows it", () => {
    withFrame("permissionsPolicy", ["clipboard-read"], () => {
      expect(frameMayNeedPermissionAfterFailure("clipboard-read", true)).toBe(false);
    });
  });

  test("does not request a grant when the page is not framed", () => {
    const self: { parent?: unknown } = {};
    self.parent = self;
    withGlobals({ window: self, document: {} }, () => {
      expect(frameMayNeedPermissionAfterFailure("clipboard-read", true)).toBe(false);
    });
  });

  test("requests help after a failed read when a frame has no policy API", () => {
    withFrame(null, [], () => {
      expect(frameMayNeedPermissionAfterFailure("clipboard-read", true)).toBe(true);
    });
  });

  test("does not request a grant when the browser has no clipboard read API", () => {
    withFrame(null, [], () => {
      expect(frameMayNeedPermissionAfterFailure("clipboard-read", false)).toBe(false);
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
      expect(takeFramePermissionGrant("clipboard-read")).toBe(true);
      expect(takeFramePermissionGrant("clipboard-read")).toBe(false);
    });
  });

  test("does not report a declined frame request as granted after opening the preview directly", () => {
    withFrame("permissionsPolicy", [], (frame) => {
      requestFramePermission("clipboard-read");
      frame.setFramed(false);
      expect(takeFramePermissionGrant("clipboard-read")).toBe(false);
      frame.setFramed(true);
      frame.allow(["clipboard-read"]);
      expect(takeFramePermissionGrant("clipboard-read")).toBe(false);
    });
  });

  test("does not announce a grant when the frame policy cannot be inspected", () => {
    withFrame(null, [], () => {
      requestFramePermission("clipboard-read");
      expect(takeFramePermissionGrant("clipboard-read")).toBe(false);
    });
  });
});
