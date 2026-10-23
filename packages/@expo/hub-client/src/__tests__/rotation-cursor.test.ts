import { describe, expect, test } from "bun:test";

import { createRotationCursor } from "../rotation-cursor";

/** Send the next step, as the iOS client does once its message is delivered. */
function requestNext(
  cursor: ReturnType<typeof createRotationCursor>,
  direction?: "left" | "right",
) {
  const next = cursor.peekNext(direction);
  cursor.recordSent(next);
  return next;
}

describe("rotation request cursor", () => {
  test("cycles right for Device Hub controls", () => {
    const cursor = createRotationCursor("portrait");
    expect(requestNext(cursor, "right")).toBe("landscape_right");
    expect(requestNext(cursor, "right")).toBe("portrait_upside_down");
  });

  test("accepts external rotation after an app never acknowledges a requested pose", () => {
    let now = 0;
    const cursor = createRotationCursor("landscape_left", () => now);
    expect(requestNext(cursor)).toBe("portrait_upside_down");
    now = 2000;
    cursor.updateReadback("portrait");
    expect(requestNext(cursor)).toBe("landscape_left");
  });

  test("gives each new request time for delayed readback, without blocking later external changes", () => {
    let now = 0;
    const cursor = createRotationCursor("portrait", () => now);
    requestNext(cursor);
    now = 1000;
    requestNext(cursor);
    now = 2000;
    cursor.updateReadback("landscape_left");
    expect(requestNext(cursor)).toBe("landscape_right");
    now = 4000;
    cursor.updateReadback("portrait");
    expect(requestNext(cursor)).toBe("landscape_left");
  });

  test("still cycles past a declined pose after a pause when no new readback arrives", () => {
    let now = 0;
    const cursor = createRotationCursor("landscape_left", () => now);
    expect(requestNext(cursor)).toBe("portrait_upside_down");
    now = 5000;
    expect(requestNext(cursor)).toBe("landscape_right");
  });

  test("advances past an app-declined pose despite delayed readback from an earlier request", () => {
    const cursor = createRotationCursor();
    expect(requestNext(cursor)).toBe("landscape_left");
    expect(requestNext(cursor)).toBe("portrait_upside_down");
    cursor.updateReadback("landscape_left");
    expect(requestNext(cursor)).toBe("landscape_right");
  });

  test("resumes following external rotation once the latest request is acknowledged", () => {
    const cursor = createRotationCursor();
    requestNext(cursor);
    requestNext(cursor);
    cursor.updateReadback("landscape_left");
    cursor.updateReadback("portrait_upside_down");
    cursor.updateReadback("portrait");
    expect(requestNext(cursor)).toBe("landscape_left");
  });

  test("starts from the device's current pose and ignores missing readback", () => {
    const cursor = createRotationCursor("landscape_right");
    expect(requestNext(cursor)).toBe("portrait");
    cursor.updateReadback(null);
    cursor.updateReadback(undefined);
    expect(requestNext(cursor)).toBe("landscape_left");
  });
});
