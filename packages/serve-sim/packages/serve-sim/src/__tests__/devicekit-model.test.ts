import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "fs";
import { createServer } from "http";
import { tmpdir } from "os";
import { join } from "path";
import { resolveDeviceKitModel, serveDeviceKitModelAsset } from "../devicekit-model";

const folders: string[] = [];
afterEach(() => { for (const folder of folders.splice(0)) rmSync(folder, { recursive: true, force: true }); });

function fixture() {
  const root = mkdtempSync(join(tmpdir(), "serve-sim-model-test-"));
  folders.push(root);
  const model = (app: string, bytes = "local USDZ") => {
    const resources = join(app, "Contents/SharedFrameworks/DeviceKit.framework/Versions/A/PlugIns/CoreDevicePopDeviceKitExtension.devicekitplugin/Contents/Resources");
    mkdirSync(resources, { recursive: true });
    const file = join(resources, "V68.usdz");
    writeFileSync(file, bytes);
    return file;
  };
  return { root, model };
}

describe("local Xcode 3D asset", () => {
  test("prefers the selected developer directory, including an app path", () => {
    const { root, model } = fixture();
    const app = join(root, "Selected.app");
    const expected = model(app);
    model(join(root, "Xcode-99.app"));
    for (const developerDir of [app, join(app, "Contents/Developer")]) {
      expect(resolveDeviceKitModel({ developerDir, applicationsDirs: [root] })).toBe(expected);
    }
  });

  test("finds another installed Xcode when the selected version has no Duo model", () => {
    const { root, model } = fixture();
    model(join(root, "Xcode-27.9.app"));
    const expected = model(join(root, "Xcode-27.10 Beta.app"));
    expect(resolveDeviceKitModel({ developerDir: join(root, "Old.app/Contents/Developer"), applicationsDirs: [root] })).toBe(expected);
    expect(resolveDeviceKitModel({ developerDir: root, applicationsDirs: [join(root, "missing")] })).toBeNull();
  });

  test("serves the installed bytes, revalidates changes, and reports a missing asset", async () => {
    const { root, model } = fixture();
    const app = join(root, "Xcode.app");
    const file = model(app, "first local USDZ");
    const options = { developerDir: app, applicationsDirs: [] };
    const server = createServer((req, res) => serveDeviceKitModelAsset(req, res, options));
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    try {
      const address = server.address();
      if (!address || typeof address === "string") throw new Error("No test server address");
      const url = `http://127.0.0.1:${address.port}/grid/api/devicekit-model`;
      const first = await fetch(url);
      expect(first.status).toBe(200);
      expect(first.headers.get("content-type")).toBe("model/vnd.usdz+zip");
      expect(await first.text()).toBe("first local USDZ");
      const headers = { "If-None-Match": first.headers.get("etag")! };
      expect((await fetch(url, { headers })).status).toBe(304);
      writeFileSync(file, "updated local Xcode USDZ");
      const updated = await fetch(url, { headers });
      expect(updated.status).toBe(200);
      expect(await updated.text()).toBe("updated local Xcode USDZ");
      rmSync(file);
      const missing = await fetch(url);
      expect(missing.status).toBe(404);
      expect(await missing.text()).toContain("Xcode");
    } finally {
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  });
});
