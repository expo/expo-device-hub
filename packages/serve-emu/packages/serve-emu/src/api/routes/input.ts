import { parseGesture, type Gesture } from "../../shared/control-contracts.ts";
import { readJsonBody } from "../body.ts";
import type { ApiDependencies } from "../dependencies.ts";
import type { ContractApiRoute } from "./types.ts";
import {
  downstream,
  invalid,
  isRecord,
  parseInput,
  shouldRecord,
} from "./route-helpers.ts";

function gestureRoute(
  type: Extract<Gesture["type"], "tap" | "swipe" | "text">,
  source: string,
): ContractApiRoute<ApiDependencies> {
  return {
    method: "POST",
    path: `/api/${type}`,
    handler: async ({ request, deps }) => {
      const payload = await readJsonBody(request);
      const gesture = parseInput(() =>
        parseGesture(isRecord(payload) ? { ...payload, type } : payload)
      );
      await downstream("dispatch input", () =>
        deps.dispatchGesture(gesture, source, shouldRecord(payload))
      );
      return Response.json({ ok: true });
    },
  };
}

export function inputRoutes(): ContractApiRoute<ApiDependencies>[] {
  return [
    gestureRoute("tap", "rest:tap"),
    gestureRoute("swipe", "rest:swipe"),
    gestureRoute("text", "rest:text"),
    {
      method: "POST",
      path: "/api/key",
      handler: async ({ request, deps }) => {
        const payload = await readJsonBody(request);
        if (!isRecord(payload)) invalid("key payload must be an object");
        const key = payload.key;
        const gesture = parseInput(() =>
          key === "back" ||
              key === "home" ||
              key === "recents" ||
              key === "power"
            ? parseGesture({ type: key })
            : parseGesture({ ...payload, type: "key" })
        );
        await downstream("dispatch key", () =>
          deps.dispatchGesture(gesture, "rest:key", shouldRecord(payload))
        );
        return Response.json({ ok: true });
      },
    },
  ];
}
