import {
  INPUT_PASTEBOARD_LOCK_TIMEOUT_MS,
  withSimPasteboardLock,
  writeSimPasteboardUnlocked,
} from "./pasteboard";

export function pasteTextIntoSim<T>(
  udid: string,
  text: string,
  sendPasteShortcut: () => Promise<T>,
  beforeWrite?: () => void,
): Promise<T> {
  return withSimPasteboardLock(
    udid,
    async () => {
      beforeWrite?.();
      await writeSimPasteboardUnlocked(udid, text);
      return sendPasteShortcut();
    },
    INPUT_PASTEBOARD_LOCK_TIMEOUT_MS,
  );
}
