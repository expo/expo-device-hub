import type { ApiDependencies } from "../dependencies.ts";
import type { ContractApiRoute } from "./types.ts";
import { applicationRoutes } from "./applications.ts";
import { cameraRoutes } from "./camera.ts";
import { deviceRoutes } from "./devices.ts";
import { inputRoutes } from "./input.ts";
import { inspectionRoutes } from "./inspection.ts";
import { locationRoutes } from "./location.ts";
import { sessionRoutes } from "./session.ts";

export function createApiRoutes(): ContractApiRoute<ApiDependencies>[] {
  return [
    ...deviceRoutes(),
    ...inspectionRoutes(),
    ...inputRoutes(),
    ...applicationRoutes(),
    ...locationRoutes(),
    ...sessionRoutes(),
    ...cameraRoutes(),
  ];
}
