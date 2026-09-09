import { describe, expect, test } from "bun:test";
import {
  fetchScreenshotPng,
  isLoopbackPreviewHostname,
} from "../client/utils/screenshot-capture";

describe("tunneled screenshot capture", () => {
  test("uses the host-only workflow exclusively for loopback previews", () => {
    expect(isLoopbackPreviewHostname("localhost")).toBe(true);
    expect(isLoopbackPreviewHostname("preview.localhost")).toBe(true);
    expect(isLoopbackPreviewHostname("127.0.0.1")).toBe(true);
    expect(isLoopbackPreviewHostname("::1")).toBe(true);
    expect(isLoopbackPreviewHostname("[::1]")).toBe(true);
    expect(isLoopbackPreviewHostname("0.0.0.0")).toBe(true);

    expect(isLoopbackPreviewHostname("serve-sim-session.example.com")).toBe(false);
    expect(isLoopbackPreviewHostname("192.168.1.20")).toBe(false);
  });

  test("posts to the screenshot endpoint for the selected device", async () => {
    const requests: Array<{ input: string; init?: RequestInit }> = [];
    const png = new Uint8Array([0x89, 0x50, 0x4e, 0x47]);
    const fetchImpl = async (input: string, init?: RequestInit) => {
      requests.push({ input, init });
      return new Response(png, {
        status: 200,
        headers: { "Content-Type": "image/png" },
      });
    };

    const blob = await fetchScreenshotPng("DEVICE A/B", {
      endpoint: "/preview/api/screenshot",
      fetchImpl,
    });

    expect(requests).toHaveLength(1);
    expect(String(requests[0]!.input)).toBe(
      "/preview/api/screenshot?device=DEVICE%20A%2FB",
    );
    expect(requests[0]!.init?.method).toBe("POST");
    expect(blob.type).toBe("image/png");
    expect(new Uint8Array(await blob.arrayBuffer())).toEqual(png);
  });

  test("surfaces the server's screenshot error", async () => {
    const fetchImpl = async () =>
      Response.json(
        { ok: false, error: "simctl screenshot timed out" },
        { status: 500 },
      );

    expect(
      fetchScreenshotPng("DEVICE-A", {
        endpoint: "/api/screenshot",
        fetchImpl,
      }),
    ).rejects.toThrow("simctl screenshot timed out");
  });

  test("rejects a non-PNG success response", async () => {
    const fetchImpl = async () =>
      new Response("upstream tunnel error", {
        status: 200,
        headers: { "Content-Type": "text/plain" },
      });

    expect(
      fetchScreenshotPng("DEVICE-A", {
        endpoint: "/api/screenshot",
        fetchImpl,
      }),
    ).rejects.toThrow("did not return a PNG");
  });
});
