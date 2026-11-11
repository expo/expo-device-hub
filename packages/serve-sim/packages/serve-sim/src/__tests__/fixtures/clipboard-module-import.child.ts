import assert from "node:assert/strict";

const events = ["exit", "SIGINT", "SIGTERM", "SIGHUP"] as const;
const before = events.map((event) => process.rawListeners(event));
const clipboard = await import("../../capabilities/clipboard");
const definition = await import("../../capabilities/clipboard/definition");
const reader = await import("../../capabilities/clipboard/reader");
const lifecycle = await import("../../capabilities/clipboard/session");
const pasteboard = await import("../../capabilities/clipboard/pasteboard");
const copy = await import("../../capabilities/clipboard/copy");
const paste = await import("../../capabilities/clipboard/paste");
const shortcut = await import("../../capabilities/clipboard/shortcut");
const capabilities = await import("../../capabilities");

assert.equal(clipboard.clipboardCapability, definition.clipboardCapability);
assert.equal(clipboard.readSimPasteboardResult, reader.readSimPasteboardResult);
assert.equal(clipboard.PasteboardUnavailableError, reader.PasteboardUnavailableError);
assert.equal(clipboard.createClipboardSession, lifecycle.createClipboardSession);
assert.equal(clipboard.writeSimPasteboard, pasteboard.writeSimPasteboard);
assert.equal(clipboard.PasteboardBusyError, pasteboard.PasteboardBusyError);
assert.equal(clipboard.PasteboardTooLargeError, pasteboard.PasteboardTooLargeError);
assert.equal(clipboard.copyFromSim, copy.copyFromSim);
assert.equal(clipboard.PasteboardCopyTimeoutError, copy.PasteboardCopyTimeoutError);
assert.equal(clipboard.pasteTextIntoSim, paste.pasteTextIntoSim);
assert.equal(clipboard.simCommandShortcutHidEvents, shortcut.simCommandShortcutHidEvents);
assert.deepEqual(capabilities.registeredCapabilities(), []);

const session = clipboard.createClipboardSession();
assert.deepEqual(
  events.map((event) => process.rawListeners(event)),
  before,
);
await session.dispose();
assert.deepEqual(
  events.map((event) => process.rawListeners(event)),
  before,
);
console.log("Clipboard imports share one implementation without installing process handlers.");
