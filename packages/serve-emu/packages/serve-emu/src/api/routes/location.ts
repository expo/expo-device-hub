import { parseGeoFix } from "../../location.ts";
import { parseRoutePlaybackRequest } from "../../route-playback.ts";
import { readJsonBody } from "../body.ts";
import type { ApiDependencies } from "../dependencies.ts";
import type { ContractApiRoute } from "./types.ts";
import {
  downstream,
  invalid,
  parseInput,
  readObject,
} from "./route-helpers.ts";

const MAX_ROUTE_BODY_BYTES = 2 * 1024 * 1024;

export function locationRoutes(): ContractApiRoute<ApiDependencies>[] {
  return [
    {
      method: "GET",
      path: "/api/location",
      handler: ({ deps }) => Response.json(deps.getLocation()),
    },
    {
      method: "POST",
      path: "/api/location",
      handler: async ({ request, deps }) => {
        const body = await readJsonBody(request);
        const fix = parseInput(() => parseGeoFix(body));
        return Response.json({
          ok: true,
          location: await downstream("set emulator location", () =>
            deps.setLocation(fix)
          ),
        });
      },
    },
    {
      method: "GET",
      path: "/api/route",
      handler: ({ deps }) => Response.json(deps.getRoute()),
    },
    {
      method: "POST",
      path: "/api/route",
      handler: async ({ request, deps }) => {
        const body = await readJsonBody(request, MAX_ROUTE_BODY_BYTES);
        const route = parseInput(() => parseRoutePlaybackRequest(body));
        return Response.json({
          ok: true,
          route: await downstream("start route", () => deps.startRoute(route)),
        });
      },
    },
    {
      method: "DELETE",
      path: "/api/route",
      handler: ({ deps }) => Response.json({ ok: true, route: deps.stopRoute() }),
    },
    {
      method: "POST",
      path: "/api/route/control",
      handler: async ({ request, deps }) => {
        const body = await readObject(request, "control payload");
        const action = body.action;
        if (action !== "pause" && action !== "resume" && action !== "stop") {
          invalid("action must be pause, resume, or stop");
        }
        return Response.json({
          ok: true,
          route: deps.controlRoute(action),
        });
      },
    },
  ];
}
