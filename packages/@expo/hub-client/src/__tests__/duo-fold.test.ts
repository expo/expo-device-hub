import { describe, expect, test } from "bun:test";

import {
  type AcknowledgedControlRequest,
  createAcknowledgedControlQueue,
} from "../acknowledged-control-queue";
import {
  duoCommandScreen,
  duoDisplayId,
  duoIntendedScreen,
  duoPhysicalPoseChanged,
} from "../duo/duo-fold";
import { type FoldControlCommand } from "../fold";

describe("iPhone Duo intended display during native handoff", () => {
  test("closing rejects the inner panel's shutdown frames before native metadata changes", () => {
    expect(duoIntendedScreen(0, null, 3)).toBe(1);
    expect(duoIntendedScreen(0, "open", 3)).toBe(1);
  });

  test("the cover owns angles through 54 degrees and the inner panel owns angles from 55 despite stale metadata", () => {
    for (const nativeScreen of [1, 3, undefined]) {
      for (const angle of [0, 1, 45, 54]) {
        expect(duoIntendedScreen(angle, null, nativeScreen)).toBe(1);
        expect(duoIntendedScreen(angle, "open", nativeScreen)).toBe(1);
      }
      for (const angle of [55, 90, 102, 150, 180]) {
        expect(duoIntendedScreen(angle, null, nativeScreen)).toBe(3);
        expect(duoIntendedScreen(angle, "closed", nativeScreen)).toBe(3);
      }
    }
  });

  test("fractional angles between the native boundaries retain the current panel", () => {
    for (const angle of [54.01, 54.5, 54.99]) {
      expect(duoIntendedScreen(angle, null, 1)).toBe(1);
      expect(duoIntendedScreen(angle, null, 3)).toBe(3);
      expect(duoIntendedScreen(angle, null)).toBe(1);
    }
  });

  test("Tent and a face-down Table Mode target the outward cover but retained tabletop poses respect slider endpoints", () => {
    for (const nativeScreen of [1, 3]) {
      expect(duoIntendedScreen(80, "tent", nativeScreen)).toBe(1);
      expect(duoIntendedScreen(55, "tent", nativeScreen)).toBe(1);
      expect(duoIntendedScreen(179, "tent", nativeScreen)).toBe(1);
      expect(duoIntendedScreen(90, "laptop", nativeScreen)).toBe(3);
      expect(duoIntendedScreen(90, null, nativeScreen, true)).toBe(1);
      for (const pose of ["tent", "laptop"] as const) {
        expect(duoIntendedScreen(0, pose, nativeScreen)).toBe(1);
        expect(duoIntendedScreen(180, pose, nativeScreen)).toBe(3);
      }
    }
  });

  test("an unknown face-down state keeps the native panel of a half-open device", () => {
    for (const nativeScreen of [1, 3] as const) {
      for (const angle of [30, 90, 150]) {
        expect(duoIntendedScreen(angle, null, nativeScreen, null)).toBe(nativeScreen);
      }
    }
    // The endpoints and Tent still decide by themselves.
    expect(duoIntendedScreen(0, null, 3, null)).toBe(1);
    expect(duoIntendedScreen(180, null, 1, null)).toBe(3);
    expect(duoIntendedScreen(90, "tent", 3, null)).toBe(1);
    // Without native readback, the angle decides as before.
    expect(duoIntendedScreen(90, null, undefined, null)).toBe(3);
    expect(duoIntendedScreen(30, null, undefined, null)).toBe(1);
    // A known face-up state follows the angle, whatever native readback says.
    expect(duoIntendedScreen(90, null, 1, false)).toBe(3);
  });

  test("uses the native active panel until the hinge angle is known", () => {
    expect(duoIntendedScreen(undefined, "tent", 3)).toBe(3);
    expect(duoIntendedScreen(undefined, "open", 1)).toBe(1);
    expect(duoIntendedScreen(undefined, null, undefined)).toBe(3);
  });

  test("a remembered preset is stale once the confirmed physical orientation disagrees", () => {
    expect(duoPhysicalPoseChanged("laptop", "landscape-left")).toBe(false);
    expect(duoPhysicalPoseChanged("laptop", "facedown")).toBe(true);
    expect(duoPhysicalPoseChanged(null, "facedown")).toBe(false);
    expect(duoPhysicalPoseChanged("book", undefined)).toBe(false);
  });
});

describe("the panel a submitted hinge command elects", () => {
  test("coalescing native angle requests never reports the discarded panel", () => {
    const sent: AcknowledgedControlRequest<FoldControlCommand>[] = [];
    const elected: (1 | 3 | undefined)[] = [];
    const queue = createAcknowledgedControlQueue<FoldControlCommand>({
      send: (request) => {
        sent.push(request);
        elected.push(duoCommandScreen(request.command));
        return true;
      },
    });
    queue.enqueue({ control: "angle", value: 40 }, { key: "angle" });
    queue.enqueue({ control: "angle", value: 55 }, { key: "angle" });
    queue.enqueue({ control: "angle", value: 54 }, { key: "angle" });
    queue.receive({ requestId: sent[0]!.requestId, ok: true });
    expect(sent.map(({ command }) => command.value)).toEqual([40, 54]);
    expect(elected).toEqual([1, 1]);
  });

  test("an away and a return each elect their own panel", () => {
    expect(duoCommandScreen({ control: "angle", value: 55 })).toBe(3);
    expect(duoCommandScreen({ control: "angle", value: 0 })).toBe(1);
  });

  test("pose commands choose their own panel and manual hinge edits retain Tent", () => {
    expect(duoCommandScreen({ control: "angle", value: 80 }, "tent")).toBe(1);
    expect(duoCommandScreen({ control: "pose", value: "open" }, "tent")).toBe(3);
    expect(duoCommandScreen({ control: "pose", value: "tent" })).toBe(1);
    expect(duoCommandScreen({ control: "tableMode", value: true })).toBeUndefined();
    expect(duoCommandScreen({ control: "faceDown", value: true })).toBeUndefined();
    expect(duoCommandScreen({ control: "angle", value: 54.5 })).toBeUndefined();
  });
});

test("serve-sim's display IDs map to platform-neutral display roles", () => {
  expect(duoDisplayId(1)).toBe("cover");
  expect(duoDisplayId(3)).toBe("inner");
  expect(duoDisplayId(2)).toBeUndefined();
  expect(duoDisplayId(undefined)).toBeUndefined();
});
