import { describe, expect, test } from "bun:test";

import {
  androidCameraErrorMessage,
  androidCameraImagePath,
  applyCameraRead,
  keepPendingCameraFeeds,
  NO_ANDROID_CAMERA,
  parseAndroidCameraStatus,
} from "../android-camera";
import { type DeviceCameraFacing } from "../types";

const stubImageUrl = (facing: DeviceCameraFacing, digest: string | null) =>
  `image:${facing}:${digest ?? "none"}`;

describe("Android camera status contract", () => {
  test("normalizes a full serve-emu payload", () => {
    const parsed = parseAndroidCameraStatus(
      {
        ok: true,
        camera: {
          serial: "emulator-5554",
          supported: true,
          wiredAtLaunch: true,
          feeds: [
            {
              facing: "back",
              path: "/tmp/back.png",
              present: true,
              placeholder: true,
              width: 640,
              height: 480,
              bytes: 1024,
              digest: "abc",
              updatedAt: "2026-01-01T00:00:00.000Z",
            },
            {
              facing: "front",
              path: "/tmp/front.png",
              present: false,
              placeholder: false,
              width: null,
              height: null,
              bytes: null,
              digest: null,
              updatedAt: null,
            },
          ],
        },
      },
      stubImageUrl,
    );

    expect(parsed).toEqual({
      supported: true,
      status: {
        wiredAtLaunch: true,
        feeds: [
          {
            facing: "back",
            placeholder: true,
            width: 640,
            height: 480,
            bytes: 1024,
            imageUrl: "image:back:abc",
          },
          {
            facing: "front",
            placeholder: false,
            width: null,
            height: null,
            bytes: null,
            imageUrl: null,
          },
        ],
      },
    });
  });

  test("rejects malformed payloads", () => {
    const camera = { supported: true, wiredAtLaunch: false, feeds: [] };
    expect(parseAndroidCameraStatus({ camera }, stubImageUrl)).toBeNull();
    expect(parseAndroidCameraStatus({ ok: true }, stubImageUrl)).toBeNull();
    expect(
      parseAndroidCameraStatus({ ok: true, camera: { ...camera, feeds: {} } }, stubImageUrl),
    ).toBeNull();
    expect(
      parseAndroidCameraStatus(
        { ok: true, camera: { ...camera, wiredAtLaunch: "yes" } },
        stubImageUrl,
      ),
    ).toBeNull();
  });

  test("drops a feed with an unknown facing and keeps its siblings", () => {
    const parsed = parseAndroidCameraStatus(
      {
        ok: true,
        camera: {
          supported: true,
          wiredAtLaunch: false,
          feeds: [
            { facing: "external", present: true, placeholder: false, digest: "zzz" },
            { facing: "front", present: true, placeholder: false, digest: null },
          ],
        },
      },
      stubImageUrl,
    );

    expect(parsed?.status.feeds).toEqual([
      {
        facing: "front",
        placeholder: false,
        width: null,
        height: null,
        bytes: null,
        imageUrl: "image:front:none",
      },
    ]);
  });
});

describe("Android camera image path", () => {
  test("adds the digest so a replaced image refetches", () => {
    expect(androidCameraImagePath("back", "a b/c")).toBe(
      "/api/camera/image?facing=back&v=a%20b%2Fc",
    );
    expect(androidCameraImagePath("front", null)).toBe("/api/camera/image?facing=front");
  });
});

describe("Android camera error message", () => {
  test("prefers the backend message over the HTTP status", () => {
    expect(androidCameraErrorMessage(500, { error: "camera not wired at launch" })).toBe(
      "camera not wired at launch",
    );
    expect(androidCameraErrorMessage(400, { error: 12 })).toBe("Camera update failed (400)");
  });
});

describe("keepPendingCameraFeeds", () => {
  const feed = (facing: "back" | "front", bytes: number) => ({
    facing,
    placeholder: false,
    width: 4,
    height: 3,
    bytes,
    imageUrl: `/img/${facing}/${bytes}`,
  });
  const current = { wiredAtLaunch: true, feeds: [feed("back", 1), feed("front", 1)] };
  const next = { wiredAtLaunch: true, feeds: [feed("back", 2), feed("front", 2)] };

  test("keeps the held feed for a pending facing and takes the rest from the new read", () => {
    const merged = keepPendingCameraFeeds(current, next, new Set(["front"]));
    expect(merged.feeds).toEqual([feed("back", 2), feed("front", 1)]);
  });

  test("returns the new read untouched when nothing is pending or nothing is held", () => {
    expect(keepPendingCameraFeeds(current, next, new Set())).toBe(next);
    expect(keepPendingCameraFeeds(null, next, new Set(["back"]))).toBe(next);
  });
});

describe("applyCameraRead", () => {
  const feed = {
    facing: "back" as const,
    placeholder: false,
    width: 4,
    height: 3,
    bytes: 9,
    imageUrl: "/img/back",
  };
  const held = {
    status: { wiredAtLaunch: true, feeds: [feed] },
    supported: true,
  };

  test("keeps the last good state when the read failed or could not be parsed", () => {
    expect(applyCameraRead(held, null, new Set())).toBe(held);
    expect(applyCameraRead(NO_ANDROID_CAMERA, null, new Set())).toBe(NO_ANDROID_CAMERA);
  });

  test("turns support off only from a payload that says so", () => {
    const read = { supported: false, status: { wiredAtLaunch: false, feeds: [] } };
    expect(applyCameraRead(held, read, new Set())).toEqual({
      status: read.status,
      supported: false,
    });
  });

  test("holds the feed of a facing with a write in flight", () => {
    const replaced = { ...feed, bytes: 1, imageUrl: "/img/back/old" };
    const read = { supported: true, status: { wiredAtLaunch: true, feeds: [replaced] } };
    expect(applyCameraRead(held, read, new Set(["back"])).status?.feeds).toEqual([feed]);
  });
});
