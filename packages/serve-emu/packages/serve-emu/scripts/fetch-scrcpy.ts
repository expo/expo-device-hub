#!/usr/bin/env bun
// The scrcpy-server download logic lives in `src/scrcpy-server.ts` so it is part
// of the library build (which compiles `src` only). This stays the
// `bun run setup` entry point and re-exports the helpers for back-compat.
import { ensureScrcpyServer } from "../src/scrcpy-server.ts";

export { SCRCPY_VERSION, SCRCPY_SERVER_PATH, ensureScrcpyServer } from "../src/scrcpy-server.ts";

if (import.meta.main) {
  await ensureScrcpyServer();
}
