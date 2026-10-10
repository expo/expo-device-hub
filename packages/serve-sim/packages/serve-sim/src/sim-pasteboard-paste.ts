import { withSimPasteboardLock, writeSimPasteboardUnlocked } from "./sim-pasteboard";

export function pasteTextIntoSim<T>(
  udid: string,
  text: string,
  sendPasteShortcut: () => Promise<T>,
): Promise<T> {
  return withSimPasteboardLock(udid, async () => {
    await writeSimPasteboardUnlocked(udid, text);
    return sendPasteShortcut();
  });
}
