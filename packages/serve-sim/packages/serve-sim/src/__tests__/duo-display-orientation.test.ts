import { expect, test } from "bun:test";
import { Euler, Vector2, Vector3 } from "three";
import { duoPose, duoScreenMapping } from "../client/simulator/duo-pose";

test("Open and Laptop fill the physical panel and keep native UI axes upright even with stale orientation metadata", () => {
  const config = { width: 2007, height: 2853, screenId: 3, orientation: "landscape_left" as const };
  const mapping = duoScreenMapping(config, 2853, 2007);
  // Coordinates of the UI's top-left, top-right, and bottom-left in the raw
  // framebuffer. Physical portrait uses the inner panel's quarter-turn;
  // physical landscape-left (Laptop) presents a portrait raw image. The old
  // orientation field can remain unchanged while these new pixels arrive.
  for (const [pose, angle, corners] of [
    ["open", 180, [[0, 1], [0, 0], [1, 1]]],
    ["laptop", 90, [[0, 0], [1, 0], [0, 1]]],
  ] as const) {
    const physical = duoPose(angle, pose, 3, config);
    const projected = corners.map(([u, v]) => {
      const pixel = new Vector2((u - 0.5) * mapping.drawnWidth, (v - 0.5) * mapping.drawnHeight)
        .rotateAround(new Vector2(), mapping.rotation);
      // These raw corners must stay on the corners of the glass, without
      // letterboxing introduced by app orientation or the model's roll.
      expect(Math.abs(pixel.x)).toBeCloseTo(mapping.width / 2, 8);
      expect(Math.abs(pixel.y)).toBeCloseTo(mapping.height / 2, 8);
      const point = new Vector3(pixel.x / mapping.width * 16, -pixel.y / mapping.height * 11.25, 0);
      point.applyAxisAngle(new Vector3(0, 1, 0), point.x < 0 ? physical.fold : -physical.fold);
      return point.applyEuler(new Euler(...physical.rotation, "YXZ"));
    });
    const [topLeft, topRight, bottomLeft] = projected as [Vector3, Vector3, Vector3];
    expect(topRight.x - topLeft.x).toBeGreaterThan(5);
    expect(topLeft.y - bottomLeft.y).toBeGreaterThan(5);
  }
});

test("the cover frame fills its physical screen when the app rotates", () => {
  const portrait = { width: 1398, height: 2034, screenId: 1, orientation: "portrait" as const };
  const landscape = { ...portrait, orientation: "landscape_right" as const };
  const before = duoScreenMapping(portrait, 1398, 2034);
  const after = duoScreenMapping(landscape, 1398, 2034);
  expect(after).toEqual(before);
});
