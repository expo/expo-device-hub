/** A writable file the browser opened for the user (the File System Access API). */
interface SaveTarget {
  createWritable(): Promise<WritableStream<Uint8Array>>;
}

type SavePicker = (options: {
  suggestedName: string;
  types: { description: string; accept: Record<string, string[]> }[];
}) => Promise<SaveTarget>;

export interface HarDownloadEnv {
  fetch: (url: string, init: RequestInit) => Promise<Response>;
  /** `window.showSaveFilePicker`, where the browser has it (Chrome, Edge). */
  showSaveFilePicker?: SavePicker;
  /** Hands a finished blob to the browser's own download. */
  saveBlob: (blob: Blob, filename: string) => void;
}

function browserEnv(): HarDownloadEnv {
  const picker = (window as unknown as { showSaveFilePicker?: SavePicker }).showSaveFilePicker;
  return {
    fetch: (url, init) => fetch(url, init),
    showSaveFilePicker: picker?.bind(window),
    saveBlob: (blob, filename) => {
      const objectUrl = URL.createObjectURL(blob);
      const anchor = document.createElement("a");
      anchor.href = objectUrl;
      anchor.download = filename;
      anchor.click();
      URL.revokeObjectURL(objectUrl);
    },
  };
}

/**
 * Save the session HAR. A HAR with opted-in bodies can reach gigabytes, so where the browser can
 * write a file the user picks, the response is streamed into it and never held in memory. Elsewhere
 * (Safari, Firefox) it falls back to a blob download. The route needs the token in a header, so a
 * plain download link cannot fetch it.
 */
export async function downloadHar(
  url: string,
  filename: string,
  headers: Record<string, string>,
  env: HarDownloadEnv = browserEnv(),
): Promise<void> {
  if (env.showSaveFilePicker) {
    let target: SaveTarget;
    try {
      // Asked before the fetch, while the click still counts as a user gesture.
      target = await env.showSaveFilePicker({
        suggestedName: filename,
        types: [{ description: "HAR file", accept: { "application/json": [".har"] } }],
      });
    } catch (error) {
      // The user closed the picker; any other failure is reported.
      if (error instanceof DOMException && error.name === "AbortError") return;
      throw error;
    }
    const response = await env.fetch(url, { headers });
    if (!response.ok || !response.body) throw new Error(`HAR download failed (HTTP ${response.status}).`);
    await response.body.pipeTo(await target.createWritable());
    return;
  }
  const response = await env.fetch(url, { headers });
  if (!response.ok) throw new Error(`HAR download failed (HTTP ${response.status}).`);
  env.saveBlob(await response.blob(), filename);
}
