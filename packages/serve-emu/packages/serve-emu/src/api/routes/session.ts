import { readJsonBody } from "../body.ts";
import type { ApiDependencies } from "../dependencies.ts";
import type { ContractApiRoute } from "./types.ts";
import { invalid, isRecord } from "./route-helpers.ts";

export function sessionRoutes(): ContractApiRoute<ApiDependencies>[] {
  return [
    {
      method: "GET",
      path: "/api/session",
      handler: ({ deps }) => Response.json(deps.getSession()),
    },
    {
      method: "DELETE",
      path: "/api/session",
      handler: ({ deps }) =>
        Response.json({ ok: true, session: deps.clearSession() }),
    },
    {
      method: "POST",
      path: "/api/session/replay",
      handler: async ({ request, deps }) => {
        const body = await readJsonBody(request);
        const multiplier = isRecord(body) ? Number(body.multiplier ?? 1) : 1;
        if (!Number.isFinite(multiplier) || multiplier <= 0 || multiplier > 100) {
          invalid("multiplier must be between 0 and 100");
        }
        return Response.json({
          ok: true,
          session: deps.replaySession(multiplier),
        });
      },
    },
    {
      method: "POST",
      path: "/api/session/replay/stop",
      handler: ({ deps }) => Response.json({
        ok: true,
        session: deps.stopSessionReplay(),
      }),
    },
  ];
}
