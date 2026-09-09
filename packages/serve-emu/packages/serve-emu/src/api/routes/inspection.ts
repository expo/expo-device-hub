import { Buffer } from "node:buffer";
import { parseAccessibilitySelector } from "../../accessibility.ts";
import type { ApiDependencies } from "../dependencies.ts";
import type { ContractApiRoute } from "./types.ts";
import {
  downstream,
  parseInput,
  readObject,
  shouldRecord,
} from "./route-helpers.ts";

export function inspectionRoutes(): ContractApiRoute<ApiDependencies>[] {
  const screenshot: ContractApiRoute<ApiDependencies>["handler"] = async ({ url, deps }) => {
    const png = await downstream("capture screenshot", deps.takeScreenshot);
    if (url.searchParams.get("format") === "base64") {
      return Response.json({
        ok: true,
        mimeType: "image/png",
        data: Buffer.from(png).toString("base64"),
      });
    }
    return new Response(Uint8Array.from(png).buffer, {
      headers: { "Content-Type": "image/png" },
    });
  };

  return [
    {
      method: "GET",
      path: "/api/logcat",
      handler: async ({ url, deps }) =>
        downstream("open logcat", () => deps.openLogcat(url)),
    },
    { method: "GET", path: "/api/screenshot", handler: screenshot },
    { method: "POST", path: "/api/screenshot", handler: screenshot },
    {
      method: "GET",
      path: "/api/foreground",
      handler: async ({ deps }) => Response.json({
        ok: true,
        app: await downstream("read foreground app", deps.getForegroundApp),
      }),
    },
    {
      method: "GET",
      path: "/api/accessibility",
      handler: async ({ deps }) =>
        Response.json(
          await downstream("read accessibility tree", deps.getAccessibility),
        ),
    },
    {
      method: "POST",
      path: "/api/accessibility/tap",
      handler: async ({ request, deps }) => {
        const body = await readObject(request, "accessibility tap payload");
        const selector = parseInput(() =>
          parseAccessibilitySelector(body.selector ?? body)
        );
        return Response.json(
          await downstream("tap accessibility node", () =>
            deps.tapAccessibility(selector, shouldRecord(body))
          ),
        );
      },
    },
  ];
}
