import { describe, expect, test } from "bun:test";
import { createRotationCursor } from "../client/simulator/rotation-cursor";

describe("rotation request cursor", () => {
  test("cycles right for Device Hub controls", () => {
    const cursor = createRotationCursor("portrait");
    expect(cursor.requestNext("right")).toBe("landscape_right");
    expect(cursor.requestNext("right")).toBe("portrait_upside_down");
  });

  test("accepts external rotation after an app never acknowledges a requested pose", () => {
    let now = 0;
    const cursor = createRotationCursor("landscape_left", () => now);
    expect(cursor.requestNext()).toBe("portrait_upside_down");
    now = 2000;
    cursor.updateReadback("portrait");
    expect(cursor.requestNext()).toBe("landscape_left");
  });

  test("gives each new request time for delayed readback, without blocking later external changes", () => {
    let now = 0;
    const cursor = createRotationCursor("portrait", () => now);
    cursor.requestNext();
    now = 1000;
    cursor.requestNext();
    now = 2000;
    cursor.updateReadback("landscape_left");
    expect(cursor.requestNext()).toBe("landscape_right");
    now = 4000;
    cursor.updateReadback("portrait");
    expect(cursor.requestNext()).toBe("landscape_left");
  });

  test("still cycles past a declined pose after a pause when no new readback arrives", () => {
    let now = 0;
    const cursor = createRotationCursor("landscape_left", () => now);
    expect(cursor.requestNext()).toBe("portrait_upside_down");
    now = 5000;
    expect(cursor.requestNext()).toBe("landscape_right");
  });

  test("advances past an app-declined pose despite delayed readback from an earlier request", () => {
    const cursor = createRotationCursor();
    expect(cursor.requestNext()).toBe("landscape_left");
    expect(cursor.requestNext()).toBe("portrait_upside_down");
    cursor.updateReadback("landscape_left");
    expect(cursor.requestNext()).toBe("landscape_right");
  });

  test("resumes following external rotation once the latest request is acknowledged", () => {
    const cursor = createRotationCursor();
    cursor.requestNext();
    cursor.requestNext();
    cursor.updateReadback("landscape_left");
    cursor.updateReadback("portrait_upside_down");
    cursor.updateReadback("portrait");
    expect(cursor.requestNext()).toBe("landscape_left");
  });

  test("starts from the device's current pose and ignores missing readback", () => {
    const cursor = createRotationCursor("landscape_right");
    expect(cursor.requestNext()).toBe("portrait");
    cursor.updateReadback(null);
    cursor.updateReadback(undefined);
    expect(cursor.requestNext()).toBe("landscape_left");
  });
});
