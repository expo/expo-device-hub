import { expect, test } from "bun:test";

import { androidOrientationBackend, writeAndroidOrientation } from "../android-orientation";

const URL = "https://hub.test/api/orientation";

test("answers the locked pose, and needs ok: true in the body", async () => {
  const answer =
    (body: unknown, status = 200) =>
    async () =>
      Response.json(body, { status });
  await expect(
    writeAndroidOrientation(
      answer({ ok: true, orientation: { pose: "landscape_left" } }),
      URL,
      "landscape_left",
    ),
  ).resolves.toBe("landscape_left");
  await expect(
    writeAndroidOrientation(answer({ ok: true, orientation: { mode: "lock" } }), URL, "landscape"),
  ).resolves.toBeNull();
  await expect(writeAndroidOrientation(answer({}), URL, "portrait")).rejects.toThrow(
    "Orientation change failed (200)",
  );
  await expect(
    writeAndroidOrientation(answer({ ok: false, error: "adb offline" }, 502), URL, "portrait"),
  ).rejects.toThrow("adb offline");
});

test("times out a request that does not answer, and a body that never ends", async () => {
  const stalled = (_url: string, init?: RequestInit) =>
    new Promise<Response>((_, reject) =>
      init?.signal?.addEventListener("abort", () => reject(init.signal?.reason)),
    );
  await expect(writeAndroidOrientation(stalled, URL, "portrait", 20)).rejects.toThrow(
    "did not answer",
  );
  // A real fetch ends its body read when the request's signal aborts; this fake does the same.
  const endless = async (_url: string, init?: RequestInit) =>
    new Response(
      new ReadableStream({
        start(controller) {
          init?.signal?.addEventListener("abort", () => controller.error(init.signal?.reason));
        },
      }),
      { headers: { "content-type": "application/json" } },
    );
  await expect(writeAndroidOrientation(endless, URL, "portrait", 20)).rejects.toThrow(
    "did not answer",
  );
});

test("older servers get portrait and landscape only", async () => {
  const sent: string[] = [];
  const fetchImpl = async (_url: string, init?: RequestInit) => {
    sent.push(JSON.parse(init?.body as string).orientation);
    return Response.json({ ok: true, orientation: {} });
  };
  const legacy = androidOrientationBackend("legacy", fetchImpl, URL);
  expect(legacy.orientations).toEqual(["portrait", "landscape_right"]);
  await legacy.set("landscape_right");
  await legacy.set("portrait");
  await androidOrientationBackend("poses", fetchImpl, URL).set("landscape_right");
  expect(sent).toEqual(["landscape", "portrait", "landscape_right"]);
});
