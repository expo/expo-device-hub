import type { CapabilityDefinition } from "../runtime/capability";
import { buildSimpbArtifact, locateSimpbArtifact } from "./pasteboard";

export const CLIPBOARD_CAPABILITY = "clipboard";

export function locatePasteboardReaderDylib(): string | null {
  return locateSimpbArtifact("libSimPasteboardReader.dylib");
}

function buildPasteboardReaderDylib(): Promise<string> {
  return buildSimpbArtifact("SimPasteboardReader", "libSimPasteboardReader.dylib");
}

export const clipboardCapability: CapabilityDefinition = {
  name: CLIPBOARD_CAPABILITY,
  defaultEnabled: true,
  scope: "allApps",
  loadDelayMs: 0,
  prebuiltDylib: locatePasteboardReaderDylib,
  async setEnabled({ enabled }) {
    if (!enabled) return null;
    return {
      dylib: locatePasteboardReaderDylib() ?? (await buildPasteboardReaderDylib()),
    };
  },
};
