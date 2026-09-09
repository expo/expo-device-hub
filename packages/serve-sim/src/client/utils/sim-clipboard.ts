import { DROP_CHUNK_BYTES, arrayBufferToBase64 } from "./drop";
import { shellEscape, type ExecResult } from "./exec";
import { HID_USAGE_BY_CODE } from "./hid";
import { randomId } from "./random-id";

// simctl encodes stdin/stdout as MacRoman unless LANG says otherwise.
const UTF8_ENV = "export LANG=en_US.UTF-8 LC_ALL=en_US.UTF-8";

// Keeps the quoted payload well under macOS ARG_MAX.
export const PBCOPY_INLINE_MAX = 48 * 1024;

export function pbpasteCommand(udid: string): string {
  return `${UTF8_ENV}; xcrun simctl pbpaste ${shellEscape(udid)}`;
}

export function pbcopyCommand(udid: string, text: string): string {
  return `${UTF8_ENV}; printf '%s' ${shellEscape(text)} | xcrun simctl pbcopy ${shellEscape(udid)}`;
}

type ExecFn = (command: string) => Promise<ExecResult>;

export type HidKeyEvent = { type: "down" | "up"; usage: number };

// Ctrl+V forwards Control, and the sim ignores Control+Command+V.
export function simPasteHidEvents(pressed: ReadonlySet<number>): HidKeyEvent[] {
  const { ControlLeft, ControlRight, MetaLeft, MetaRight, KeyV } = HID_USAGE_BY_CODE;
  if (MetaLeft === undefined || KeyV === undefined) return [];

  const held = (usage: number | undefined): usage is number =>
    usage !== undefined && pressed.has(usage);

  const events: HidKeyEvent[] = [];
  if (held(ControlLeft)) events.push({ type: "up", usage: ControlLeft });
  if (held(ControlRight)) events.push({ type: "up", usage: ControlRight });
  const commandAlreadyDown = held(MetaLeft) || held(MetaRight);
  if (!commandAlreadyDown) events.push({ type: "down", usage: MetaLeft });
  events.push({ type: "down", usage: KeyV });
  events.push({ type: "up", usage: KeyV });
  if (!commandAlreadyDown) events.push({ type: "up", usage: MetaLeft });
  return events;
}

export async function copyTextToSim(udid: string, text: string, exec: ExecFn): Promise<boolean> {
  const bytes = new TextEncoder().encode(text);
  if (bytes.length <= PBCOPY_INLINE_MAX) {
    const result = await exec(pbcopyCommand(udid, text));
    return result.exitCode === 0;
  }

  const tmpPath = `/tmp/serve-sim-pbcopy-${randomId()}`;
  try {
    for (let offset = 0; offset < bytes.length; offset += DROP_CHUNK_BYTES) {
      const slice = bytes.subarray(offset, offset + DROP_CHUNK_BYTES);
      const chunk = arrayBufferToBase64(Uint8Array.from(slice).buffer);
      const op = offset === 0 ? ">" : ">>";
      const wrote = await exec(`bash -c 'echo ${chunk} | base64 -d ${op} ${shellEscape(tmpPath)}'`);
      if (wrote.exitCode !== 0) return false;
    }
    const copied = await exec(
      `${UTF8_ENV}; xcrun simctl pbcopy ${shellEscape(udid)} < ${shellEscape(tmpPath)}`,
    );
    return copied.exitCode === 0;
  } finally {
    await exec(`rm -f ${shellEscape(tmpPath)}`).catch(() => {});
  }
}

export async function readSimClipboard(udid: string, exec: ExecFn): Promise<string> {
  const { stdout, exitCode } = await exec(pbpasteCommand(udid));
  if (exitCode !== 0) {
    throw new Error("Could not read the simulator clipboard. Is the device still booted?");
  }
  return stdout;
}

// Secure contexts include http://localhost but not the LAN URL from `--host 0.0.0.0`.
export function canWriteBrowserClipboardAsync(): boolean {
  return Boolean(navigator.clipboard?.write ?? navigator.clipboard?.writeText);
}

// Only works synchronously inside a user gesture, so the async read hands off to a button.
export function copyTextViaSelection(text: string): boolean {
  const textarea = document.createElement("textarea");
  textarea.value = text;
  textarea.setAttribute("readonly", "");
  textarea.style.cssText = "position:fixed;top:0;left:0;opacity:0;pointer-events:none";
  document.body.appendChild(textarea);
  textarea.select();
  textarea.setSelectionRange(0, text.length);
  try {
    return document.execCommand("copy");
  } finally {
    textarea.remove();
  }
}

export function writeTextToBrowserClipboard(textPromise: Promise<string>): Promise<void> {
  const clipboard = navigator.clipboard;
  if (!clipboard?.write && !clipboard?.writeText) return textPromise.then(() => undefined);

  // Safari drops the user gesture across an await.
  if (typeof ClipboardItem !== "undefined" && clipboard.write) {
    const item = new ClipboardItem({
      "text/plain": textPromise.then((text) => new Blob([text], { type: "text/plain" })),
    });
    return clipboard.write([item]);
  }

  return textPromise.then((text) => clipboard.writeText(text));
}
