import { expect, test } from "bun:test";
import { UNSUPPORTED_INSTALL_FORMAT } from "../app-install-format";
import { createAppDropClient } from "../client/utils/app-drop-client";

function transport() {
  const calls: Array<{ action: string; params: Record<string, unknown> }> = [];
  const run = async (action: string, params: Record<string, unknown> = {}) => {
    calls.push({ action, params });
    return { stdout: "", stderr: "", exitCode: 0 };
  };
  return { calls, run: run as unknown as Parameters<typeof createAppDropClient>[0] };
}

const WORKER = { url: "http://host.test/app-drop-worker.js", headers: {} };

test.each(["Device.ipa", "Build.zip"])(
  "gives the Simulator-build message for %s before any upload",
  async (name) => {
    const { calls, run } = transport();
    const client = createAppDropClient(run, "U", WORKER);
    await expect(client.installFile(new File(["x"], name), () => {})).rejects.toThrow(
      UNSUPPORTED_INSTALL_FORMAT,
    );
    expect(calls).toEqual([]);
  },
);

test("gives drop guidance for a file that is not an app archive", async () => {
  const { calls, run } = transport();
  const client = createAppDropClient(run, "U", WORKER);
  await expect(client.installFile(new File(["x"], "notes.txt"), () => {})).rejects.toThrow(
    "Drop a Simulator .app folder or .tar.gz/.tgz archive.",
  );
  expect(calls).toEqual([]);
});
