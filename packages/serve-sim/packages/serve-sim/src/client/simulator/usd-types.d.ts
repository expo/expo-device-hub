// Three exposes these USD loading helpers but does not yet ship their types.
declare module "three/addons/loaders/usd/USDCParser.js" {
  export type USDLayer = { specsByPath: Record<string, { specType: number; fields: Record<string, unknown> }> };
  export class USDCParser {
    parseData(buffer: ArrayBuffer): USDLayer;
  }
}

declare module "three/addons/loaders/usd/USDComposer.js" {
  import type { Group } from "three";
  import type { USDLayer } from "three/addons/loaders/usd/USDCParser.js";
  export class USDComposer {
    texturePromises: Promise<void>[];
    compose(data: USDLayer, assets: Record<string, Uint8Array>, variants?: Record<string, string>, basePath?: string): Group;
  }
}
