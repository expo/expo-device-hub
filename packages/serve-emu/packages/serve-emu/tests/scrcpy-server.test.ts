import { afterEach, expect, test } from "bun:test";
import { downloadWithRetry, scrcpyServerUrl, SCRCPY_VERSION } from "../src/scrcpy-server.ts";

const realFetch = globalThis.fetch;

afterEach(() => {
  globalThis.fetch = realFetch;
});

function stubFetch(responses: Array<Response | Error>): string[] {
  const urls: string[] = [];
  globalThis.fetch = (async (input: string | URL | Request) => {
    urls.push(String(input));
    const next = responses.shift();
    if (!next) throw new Error("unexpected fetch");
    if (next instanceof Error) throw next;
    return next;
  }) as typeof fetch;
  return urls;
}

test("scrcpyServerUrl uses SERVE_EMU_SCRCPY_SERVER_URL when it is set", () => {
  expect(
    scrcpyServerUrl({ SERVE_EMU_SCRCPY_SERVER_URL: "https://mirror.test/scrcpy-server" }),
  ).toBe("https://mirror.test/scrcpy-server");
  expect(scrcpyServerUrl({})).toBe(
    `https://github.com/Genymobile/scrcpy/releases/download/v${SCRCPY_VERSION}/scrcpy-server-v${SCRCPY_VERSION}`,
  );
});

test("downloadWithRetry retries a 5xx and returns the file", async () => {
  const urls = stubFetch([
    new Response("", { status: 504, statusText: "Gateway Time-out" }),
    new Response(new Uint8Array([1, 2, 3]), { status: 200 }),
  ]);
  const buf = await downloadWithRetry("https://mirror.test/scrcpy-server", { baseDelayMs: 0 });
  expect(Array.from(buf)).toEqual([1, 2, 3]);
  expect(urls).toHaveLength(2);
});

test("downloadWithRetry retries a network error", async () => {
  stubFetch([new TypeError("fetch failed"), new Response(new Uint8Array([7]), { status: 200 })]);
  const buf = await downloadWithRetry("https://mirror.test/scrcpy-server", { baseDelayMs: 0 });
  expect(Array.from(buf)).toEqual([7]);
});

test("downloadWithRetry stops after the last attempt with the download error", async () => {
  const urls = stubFetch([
    new Response("", { status: 504, statusText: "Gateway Time-out" }),
    new Response("", { status: 502, statusText: "Bad Gateway" }),
    new Response("", { status: 504, statusText: "Gateway Time-out" }),
  ]);
  await expect(
    downloadWithRetry("https://mirror.test/scrcpy-server", { attempts: 3, baseDelayMs: 0 }),
  ).rejects.toThrow("Failed to download https://mirror.test/scrcpy-server: 504 Gateway Time-out");
  expect(urls).toHaveLength(3);
});

test("downloadWithRetry does not retry a 404", async () => {
  const urls = stubFetch([new Response("", { status: 404, statusText: "Not Found" })]);
  await expect(
    downloadWithRetry("https://mirror.test/scrcpy-server", { baseDelayMs: 0 }),
  ).rejects.toThrow("Failed to download https://mirror.test/scrcpy-server: 404 Not Found");
  expect(urls).toHaveLength(1);
});
