import {
  assertCameraImage,
  cameraImageResponse,
  MAX_CAMERA_IMAGE_BYTES,
  parseCameraFacing,
} from "../../camera.ts";
import { ApiError } from "../api-error.ts";
import { readBodyBytes } from "../body.ts";
import type { ApiDependencies } from "../dependencies.ts";
import type { ContractApiRoute } from "./types.ts";
import { downstream, parseInput } from "./route-helpers.ts";

export function cameraRoutes(): ContractApiRoute<ApiDependencies>[] {
  return [
    {
      method: "GET",
      path: "/api/camera",
      handler: async ({ deps }) =>
        Response.json({
          ok: true,
          camera: await downstream("read camera status", () => deps.getCamera()),
        }),
    },
    {
      method: "GET",
      path: "/api/camera/image",
      handler: async ({ url, deps }) => {
        const facing = parseInput(() =>
          parseCameraFacing(url.searchParams.get("facing")),
        );
        const png = await downstream("read camera image", () =>
          deps.readCameraImage(facing),
        );
        if (!png) {
          throw new ApiError(404, "not_found", "no camera image is set for this facing");
        }
        return cameraImageResponse(png);
      },
    },
    {
      method: "POST",
      path: "/api/camera/image",
      handler: async ({ request, url, deps }) => {
        const facing = parseInput(() =>
          parseCameraFacing(url.searchParams.get("facing")),
        );
        const png = await readBodyBytes(request, MAX_CAMERA_IMAGE_BYTES);
        parseInput(() => assertCameraImage(png));
        await downstream("set camera image", () => deps.setCameraImage(facing, png));
        return Response.json({
          ok: true,
          camera: await downstream("read camera status", () => deps.getCamera()),
        });
      },
    },
    {
      method: "DELETE",
      path: "/api/camera/image",
      handler: async ({ url, deps }) => {
        const facing = parseInput(() =>
          parseCameraFacing(url.searchParams.get("facing")),
        );
        await downstream("clear camera image", () => deps.clearCameraImage(facing));
        return Response.json({
          ok: true,
          camera: await downstream("read camera status", () => deps.getCamera()),
        });
      },
    },
  ];
}
