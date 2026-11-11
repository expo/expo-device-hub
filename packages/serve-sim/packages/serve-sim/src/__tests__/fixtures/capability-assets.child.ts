import { existsSync } from "node:fs";
import { locatePasteboardTool } from "../../capabilities/clipboard/pasteboard";
import { locatePasteboardReaderDylib } from "../../capabilities/clipboard/definition";
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
    pasteboardTool: locatePasteboardTool(),
    pasteboardReader: locatePasteboardReaderDylib(),
  }),
);
