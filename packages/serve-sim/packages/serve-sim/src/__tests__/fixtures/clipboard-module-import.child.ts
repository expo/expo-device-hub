import assert from "node:assert/strict";

const events = ["exit", "SIGINT", "SIGTERM", "SIGHUP"] as const;
const before = events.map((event) => process.rawListeners(event));
const clipboard = await import("../../capabilities/clipboard");
const legacyReader = await import("../../sim-pasteboard-reader");
const legacySession = await import("../../clipboard-session");

assert.equal(clipboard.clipboardCapability, legacyReader.clipboardCapability);
assert.equal(clipboard.readSimPasteboardResult, legacyReader.readSimPasteboardResult);
assert.equal(clipboard.PasteboardUnavailableError, legacyReader.PasteboardUnavailableError);
assert.equal(clipboard.createClipboardSession, legacySession.createClipboardSession);

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
