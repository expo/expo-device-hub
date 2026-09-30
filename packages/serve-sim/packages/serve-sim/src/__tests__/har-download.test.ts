import { describe, expect, test } from "bun:test";

import { downloadHar, type HarDownloadEnv } from "../client/utils/har-download";

const HAR = '{"log":{"entries":[]}}';

function env(overrides: Partial<HarDownloadEnv> = {}) {
  const calls = { fetched: 0, blobs: [] as string[], written: [] as string[], headers: [] as unknown[] };
  const base: HarDownloadEnv = {
    fetch: async (_url, init) => {
      calls.fetched++;
      calls.headers.push(init.headers);
      return new Response(HAR);
    },
    saveBlob: (blob) => void blob.text().then((text) => calls.blobs.push(text)),
    ...overrides,
  };
  return { env: base, calls };
}

function pickedFile(calls: { written: string[] }) {
  return async () => ({
    createWritable: async () => {
      const decoder = new TextDecoder();
      return new WritableStream<Uint8Array>({ write: (chunk) => void calls.written.push(decoder.decode(chunk)) });
    },
  });
}

describe("downloadHar", () => {
  test("streams the HAR into the file the user picks, without a blob", async () => {
    const { env: e, calls } = env();
    e.showSaveFilePicker = pickedFile(calls);
    await downloadHar("/network-capture.har", "a.har", { Authorization: "Bearer t" }, e);
    expect(calls.written.join("")).toBe(HAR);
    expect(calls.blobs).toEqual([]);
    expect(calls.headers).toEqual([{ Authorization: "Bearer t" }]);
  });

  test("fetches nothing when the user closes the picker", async () => {
    const { env: e, calls } = env({ showSaveFilePicker: async () => { throw new DOMException("closed", "AbortError"); } });
    await downloadHar("/network-capture.har", "a.har", {}, e);
    expect(calls.fetched).toBe(0);
  });

  test("reports a picker that fails for another reason than being closed", async () => {
    const { env: e, calls } = env({ showSaveFilePicker: async () => { throw new DOMException("denied", "SecurityError"); } });
    await expect(downloadHar("/network-capture.har", "a.har", {}, e)).rejects.toThrow("denied");
    expect(calls.fetched).toBe(0);
  });

  test("falls back to a blob download where the browser cannot write a picked file", async () => {
    const { env: e, calls } = env();
    await downloadHar("/network-capture.har", "a.har", {}, e);
    await Bun.sleep(0);
    expect(calls.blobs).toEqual([HAR]);
  });

  test("reports a failed response instead of saving it", async () => {
    const { env: e, calls } = env({ fetch: async () => new Response("no", { status: 404 }) });
    e.showSaveFilePicker = pickedFile(calls);
    await expect(downloadHar("/network-capture.har", "a.har", {}, e)).rejects.toThrow("HTTP 404");
    expect(calls.written).toEqual([]);
  });
});
