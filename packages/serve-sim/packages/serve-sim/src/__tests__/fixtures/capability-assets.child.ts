import { existsSync } from "node:fs";
import {
  capabilityAssetBaseDir,
  capabilityLoaderDir,
  capabilityLoaderPath,
} from "../../capabilities/runtime/assets";

console.log(
  JSON.stringify({
    base: capabilityAssetBaseDir(),
    directory: capabilityLoaderDir(),
    path: capabilityLoaderPath(),
    exists: existsSync(capabilityLoaderPath()),
  }),
);
