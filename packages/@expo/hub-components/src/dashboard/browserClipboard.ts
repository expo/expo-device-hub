/** Read the browser clipboard as text. Rejects without the API, without permission, or without focus. */
export async function readBrowserClipboard(): Promise<string> {
  const clipboard = typeof navigator === 'undefined' ? undefined : navigator.clipboard;
  if (!clipboard?.readText) throw new Error('This browser cannot read the clipboard.');
  return await clipboard.readText();
}

/** Write text to the browser clipboard. Rejects when the browser has no API or does not allow it. */
export async function writeBrowserClipboard(value: string): Promise<void> {
  const clipboard = typeof navigator === 'undefined' ? undefined : navigator.clipboard;
  if (!clipboard?.writeText) throw new Error('This browser cannot write the clipboard.');
  await clipboard.writeText(value);
}

/**
 * Copy the text of a field with the legacy selection copy, as serve-sim's `copyTextViaSelection`.
 * It needs no clipboard permission. The field keeps its selection. Returns false instead of throwing.
 */
export function copyFieldSelection(field: HTMLTextAreaElement | null): boolean {
  if (!field) return false;
  try {
    field.focus();
    field.select();
    return document.execCommand('copy');
  } catch {
    return false;
  }
}

export function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
