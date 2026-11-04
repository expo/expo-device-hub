import { expect, test } from "bun:test";
import { untar } from "multitars";
import { runChildSuite } from "./fixtures/run-child-suite";

test("the worker client propagates failures and cleans up cancelled uploads", async () => {
  const { exitCode, output } = await runChildSuite("app-drop-worker-client.child.ts", {
    timeoutMs: 10000,
  });
  expect(exitCode, output).toBe(0);
}, 15000);

test("the real packing worker preserves files and only emits chunks when pulled", async () => {
  const worker = new Worker(new URL("../client/utils/app-drop-worker.ts", import.meta.url).href);
  const inbox: MessageEvent[] = [];
  let wake: (() => void) | undefined;
  worker.onmessage = (event) => {
    inbox.push(event);
    wake?.();
  };
  const next = async () => {
    while (!inbox.length)
      await new Promise<void>((resolve) => {
        wake = resolve;
      });
    return inbox.shift()!.data;
  };
  try {
    worker.postMessage({
      type: "start",
      bytes: 4,
      items: [
        { path: "Test.app" },
        {
          path: "Test.app/Test",
          file: new File([new Uint8Array([0xcf, 0xfa, 0xed, 0xfe])], "Test"),
        },
      ],
    });
    expect((await next()).type).toBe("ready");
    expect(inbox).toHaveLength(0);
    const chunks: Uint8Array<ArrayBuffer>[] = [];
    let done = false;
    while (!done) {
      worker.postMessage({ type: "pull" });
      for (;;) {
        const reply = await next();
        if (reply.type === "progress") continue;
        expect(reply.type === "chunk" || reply.type === "done").toBe(true);
        done = reply.type === "done";
        if (!done) chunks.push(reply.bytes);
        break;
      }
    }
    const archive = new Blob(chunks).stream().pipeThrough(new DecompressionStream("gzip"));
    const files = [];
    for await (const entry of untar(archive))
      files.push({ name: entry.name, mode: entry.mode, bytes: await entry.arrayBuffer() });
    expect(files.map((file) => file.name)).toEqual(["Test.app/", "Test.app/Test"]);
    expect(files[1]!.mode).toBe(0o700);
    expect(new Uint8Array(files[1]!.bytes)).toEqual(new Uint8Array([0xcf, 0xfa, 0xed, 0xfe]));
  } finally {
    worker.terminate();
  }
}, 10000);
