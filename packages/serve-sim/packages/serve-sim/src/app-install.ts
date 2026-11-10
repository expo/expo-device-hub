import { randomUUID } from "node:crypto";
import { join } from "node:path";
import {
  actionTimeoutMs,
  createSerialQueue,
  installAppInvocation,
  runInvocation,
  serveSimInvocation,
  ensurePrivateDirAsync,
  type HostActionResult,
} from "./host-actions-utils";
import { UPLOAD_DIR } from "./host-paths";

const installArchive = createSerialQueue();
const CLEANUP_GRACE_MS = 10_000;
// One private path per serving process bounds leftovers even if removal fails.
// The preparation child's exclusive mkdir refuses another extraction into it.
let extractionDirectory: string | undefined;

export async function installAppAsync(
  udid: string,
  path: string,
  deadline = Date.now() + actionTimeoutMs(),
  serveSimBinPath = "serve-sim",
): Promise<HostActionResult> {
  return installArchive(async () => {
    const directory = (extractionDirectory ??= join(
      UPLOAD_DIR,
      `.install-extract-${deadline}-${randomUUID()}`,
    ));
    const remaining = () => Math.max(1, deadline - Date.now());
    let result: HostActionResult = {
      stdout: "",
      stderr: "App installation timed out.",
      exitCode: 1,
      timedOut: true,
    };
    try {
      if (Date.now() < deadline) {
        await ensurePrivateDirAsync(UPLOAD_DIR);
        const prepared = await runInvocation({
          ...serveSimInvocation(serveSimBinPath, ["_prepare-app-install", path, directory]),
          timeoutMs: remaining(),
        });
        if (prepared.exitCode !== 0) result = prepared;
        else if (Date.now() < deadline) {
          const app: unknown = JSON.parse(prepared.stdout);
          if (typeof app !== "string" || !(app === path || app.startsWith(directory + "/")))
            throw new Error("App preparation returned an invalid path.");
          result = await runInvocation({
            ...installAppInvocation(udid, app),
            timeoutMs: remaining(),
          });
        }
      }
    } catch {
      result = { stdout: "", stderr: "App preparation failed.", exitCode: 1 };
    } finally {
      if (result.timedOut) result.stderr = "App installation timed out.";
      // Preparation has exited, closing all writers before removal. Cleanup
      // uses the remaining action budget, with a bounded grace after expiry.
      const cleanup = await runInvocation({
        file: "rm",
        args: ["-rf", "--", directory],
        timeoutMs: Math.max(CLEANUP_GRACE_MS, remaining()),
      });
      if (cleanup.exitCode !== 0)
        result.stderr += " Temporary app files could not be removed; the host may need cleanup.";
      else extractionDirectory = undefined;
    }
    return result;
  });
}
