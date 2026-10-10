import { describe, expect, test } from "bun:test";
import { requestFramePermission, shouldAskFrameForClipboardRead, takeFramePermissionGrant } from "../client/utils/frame-permission";

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
  const nav = { clipboard: { readText: async () => "" } };
  withGlobals({ window: win, document: doc, navigator: nav }, () => run({
    posted,
    allow: (next) => { features = next; },
    setFramed: (framed) => { (win as { parent: unknown }).parent = framed ? parent : win; },
  }));
}

describe("shouldAskFrameForClipboardRead", () => {
  test("requests help after a failed read when the embedding page did not grant permission", () => {
    withFrame("permissionsPolicy", ["clipboard-write"], () => {
      expect(shouldAskFrameForClipboardRead()).toBe(true);
    });
  });

  test("reads the older featurePolicy API", () => {
    withFrame("featurePolicy", ["clipboard-write"], () => {
      expect(shouldAskFrameForClipboardRead()).toBe(true);
    });
  });

  test("does not request a grant for unrelated read failures when policy allows it", () => {
    withFrame("permissionsPolicy", ["clipboard-read"], () => {
      expect(shouldAskFrameForClipboardRead()).toBe(false);
    });
  });

  test("does not request a grant when the page is not framed", () => {
    const self: { parent?: unknown } = {};
    self.parent = self;
    withGlobals({ window: self, document: {} }, () => {
      expect(shouldAskFrameForClipboardRead()).toBe(false);
    });
  });

  test("requests help after a failed read when a frame has no policy API", () => {
    withFrame(null, [], () => {
      expect(shouldAskFrameForClipboardRead()).toBe(true);
    });
  });

  test("does not request a grant when the browser has no readText", () => {
    withFrame(null, [], () => {
      withGlobals({ navigator: { clipboard: {} } }, () => {
        expect(shouldAskFrameForClipboardRead()).toBe(false);
      });
      withGlobals({ navigator: {} }, () => {
        expect(shouldAskFrameForClipboardRead()).toBe(false);
      });
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
      expect(takeFramePermissionGrant("clipboard-read")).toBeNull();

      requestFramePermission("clipboard-read");
      expect(takeFramePermissionGrant("clipboard-read")).toBeNull();

      frame.allow(["clipboard-read"]);
      expect(takeFramePermissionGrant("clipboard-read")).toBe("allowed");
      expect(takeFramePermissionGrant("clipboard-read")).toBeNull();
    });
  });

  test("does not report a declined frame request as granted after a load outside a frame", () => {
    withFrame("permissionsPolicy", [], (frame) => {
      requestFramePermission("clipboard-read");
      frame.setFramed(false);
      expect(takeFramePermissionGrant("clipboard-read")).toBeNull();
      frame.setFramed(true);
      frame.allow(["clipboard-read"]);
      expect(takeFramePermissionGrant("clipboard-read")).toBeNull();
    });
  });

  test("reports the first load after a request once as unknown when the browser has no policy API", () => {
    withFrame(null, [], () => {
      expect(takeFramePermissionGrant("clipboard-read")).toBeNull();
      requestFramePermission("clipboard-read");
      expect(takeFramePermissionGrant("clipboard-read")).toBe("unknown");
      expect(takeFramePermissionGrant("clipboard-read")).toBeNull();
    });
  });
});
