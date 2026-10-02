import { screenshotResponse } from "../../screenshot-response.ts";
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
    return screenshotResponse(png, url);
  };

  return [
    {
      method: "GET",
      path: "/api/logcat",
      handler: async ({ url, deps }) =>
        downstream("open logcat", () => deps.openLogcat(url)),
    },
    {
      method: "GET",
      path: "/api/metrics",
      handler: async ({ deps }) =>
        downstream("open metrics", () => deps.openMetrics()),
    },
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
