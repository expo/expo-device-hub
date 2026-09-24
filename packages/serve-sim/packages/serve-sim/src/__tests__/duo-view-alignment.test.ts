import { describe, expect, test } from "bun:test";
import { Euler, Quaternion, Vector2, Vector3 } from "three";
import { duoFrameMatchesDisplay, duoIntendedScreen, duoPose, duoScreenMapping } from "../client/simulator/duo-pose";
import type { StreamConfig } from "../client/types";

const hingeAxis = new Vector3(0, 1, 0);

function expectDirection(actual: Vector3, expected: Vector3, precision = 8) {
  const direction = actual.clone().normalize();
  expect(direction.x).toBeCloseTo(expected.x, precision);
  expect(direction.y).toBeCloseTo(expected.y, precision);
  expect(direction.z).toBeCloseTo(expected.z, precision);
}

function panelDirection(direction: Vector3, side: "left" | "right", physical: ReturnType<typeof duoPose>) {
  return direction.clone()
    .applyAxisAngle(hingeAxis, side === "left" ? physical.fold : -physical.fold)
    .applyEuler(new Euler(...physical.rotation, "YXZ"));
}

function rawUiDirection(direction: Vector2, config: StreamConfig, physical: ReturnType<typeof duoPose>) {
  const mapping = duoScreenMapping(config, config.height, config.width);
  const mounted = direction.clone().rotateAround(new Vector2(), mapping.rotation);
  // Raw and canvas Y point down, while the model's Y points up.
  return new Vector3(mounted.x, -mounted.y, 0)
    .applyEuler(new Euler(...physical.rotation, "YXZ"));
}

describe("iPhone Duo view alignment", () => {
  test("Closed presents the cover exactly front-on and upright", () => {
    const closed = duoPose(0, "closed", 1);
    // Apple's cover is on the rear (-Z) of the left articulated half.
    expectDirection(panelDirection(new Vector3(0, 0, -1), "left", closed), new Vector3(0, 0, 1));
    expectDirection(panelDirection(hingeAxis, "left", closed), new Vector3(0, 1, 0));
  });

  test("Open presents both inner panels exactly front-on without a perspective skew", () => {
    const open = duoPose(180, "open", 3);
    for (const side of ["left", "right"] as const) {
      expectDirection(panelDirection(new Vector3(0, 0, 1), side, open), new Vector3(0, 0, 1));
    }
    expectDirection(panelDirection(hingeAxis, "left", open), new Vector3(0, 1, 0));
  });

  test("initial Open framing keeps portrait and landscape-left native UI axes upright", () => {
    for (const orientation of ["portrait", "landscape_left"] as const) {
      const config = { width: 2007, height: 2853, screenId: 3, orientation };
      const open = duoPose(180, "open", 3, config);
      const rawRight = orientation === "portrait" ? new Vector2(1, 0) : new Vector2(0, -1);
      const rawUp = orientation === "portrait" ? new Vector2(0, -1) : new Vector2(-1, 0);
      expectDirection(rawUiDirection(rawRight, config, open), new Vector3(1, 0, 0));
      expectDirection(rawUiDirection(rawUp, config, open), new Vector3(0, 1, 0));
      expectDirection(panelDirection(new Vector3(0, 0, 1), "left", open), new Vector3(0, 0, 1));
    }
  });

  test("Laptop shows its front and right-side depth above a level lower panel", () => {
    const laptop = duoPose(90, "laptop", 3);
    const elevation = Math.PI / 9;
    const cameraRight = new Vector3(1, 0, 0);
    const levelView = (point: Vector3) => point.clone().applyAxisAngle(cameraRight, -elevation);
    const ridge = levelView(panelDirection(hingeAxis, "left", laptop));
    const azimuth = Math.atan2(ridge.z, -ridge.x);
    expect(azimuth).toBeLessThan(-Math.PI / 18);
    expect(azimuth).toBeGreaterThan(-Math.PI / 6);
    expect(ridge.y).toBeCloseTo(0, 8);
    const baseNormal = panelDirection(new Vector3(0, 0, 1), "left", laptop);
    // Looking around the table must not tilt its normal sideways. Only the
    // camera's elevation changes where world-up points in the image.
    expectDirection(baseNormal, new Vector3(0, Math.cos(elevation), Math.sin(elevation)));
    const backNormal = levelView(panelDirection(new Vector3(0, 0, 1), "right", laptop));
    expect(backNormal.y).toBeCloseTo(0, 8);
    expectDirection(backNormal.applyAxisAngle(hingeAxis, -azimuth), new Vector3(0, 0, 1));
    // The lower panel extends forward from the hinge instead of below it.
    const lowerEdge = panelDirection(new Vector3(-1, 0, 0), "left", laptop)
      .applyAxisAngle(cameraRight, -elevation)
      .applyAxisAngle(hingeAxis, -azimuth);
    expect(lowerEdge.y).toBeCloseTo(0, 8);
    expect(lowerEdge.z).toBeGreaterThan(0);
  });

  test("Tent shows the cover and right-side depth with both feet on a level table", () => {
    const tent = duoPose(80, "tent", 3);
    const coverNormal = panelDirection(new Vector3(0, 0, -1), "left", tent);
    const innerCounterpart = panelDirection(new Vector3(0, 0, 1), "left", tent);
    expect(coverNormal.z).toBeGreaterThan(0.5);
    expect(coverNormal.x).toBeLessThan(-0.15);
    expect(coverNormal.y).toBeGreaterThan(0);
    expect(innerCounterpart.z).toBeLessThan(-0.5);
    expectDirection(coverNormal.clone().negate(), innerCounterpart);
    const levelView = (point: Vector3) => point.clone().applyAxisAngle(new Vector3(1, 0, 0), -Math.PI / 18);
    const ridge = levelView(panelDirection(hingeAxis, "left", tent));
    const azimuth = Math.atan2(-ridge.z, ridge.x);
    expect(azimuth).toBeLessThan(-Math.PI / 18);
    expect(azimuth).toBeGreaterThan(-Math.PI / 6);
    expect(ridge.y).toBeCloseTo(0, 8);

    const frontFoot = panelDirection(new Vector3(-1, 0, 0), "left", tent);
    const rearFoot = panelDirection(new Vector3(1, 0, 0), "right", tent);
    expect(frontFoot.y).toBeLessThan(0);
    expect(rearFoot.y).toBeLessThan(0);
    expect(frontFoot.z).toBeGreaterThan(0);
    expect(rearFoot.z).toBeLessThan(0);
    expect(levelView(frontFoot).y).toBeCloseTo(levelView(rearFoot).y, 8);
  });

  test("tabletop orientation stays level across hinge angles and viewing directions", () => {
    for (const angle of [0, 1, 15, 30, 55, 80, 90, 120, 150, 165, 179, 180]) {
      for (const elevation of [0, 10, 20, 45, 90]) {
        const radians = elevation * Math.PI / 180;
        const tableNormal = new Vector3(0, Math.cos(radians), Math.sin(radians));
        for (const rotation of [-180, -90, -20, 0, 45, 90, 180]) {
          const view = { elevation, rotation };
          const laptop = duoPose(angle, "laptop", 3, undefined, undefined, view);
          expectDirection(panelDirection(new Vector3(0, 0, 1), "left", laptop), tableNormal, 6);
          const tent = duoPose(angle, "tent", 1, undefined, undefined, view);
          // All four ends of the two supporting edges have the same height
          // on the table, including when viewed from the side or from above.
          const contacts = [-1, 1].flatMap((end) => [
            panelDirection(new Vector3(-1, end, 0), "left", tent),
            panelDirection(new Vector3(1, end, 0), "right", tent),
          ]);
          const height = contacts[0]!.dot(tableNormal);
          for (const contact of contacts) expect(contact.dot(tableNormal)).toBeCloseTo(height, 6);
        }
      }
    }
  });

  test("manual hinge changes retain the tabletop viewing direction through both endpoints", () => {
    const coverConfig = { width: 1398, height: 2034, screenId: 1, orientation: "portrait" as const };
    const innerConfig = { width: 2007, height: 2853, screenId: 3, orientation: "portrait" as const };
    for (const pose of ["laptop", "tent"] as const) {
      const direction = panelDirection(hingeAxis, "left", duoPose(pose === "laptop" ? 90 : 80, pose));
      for (let angle = 0; angle <= 180; angle++) {
        const config = angle <= 54 ? coverConfig : innerConfig;
        const physical = duoPose(angle, pose, config.screenId, config);
        expectDirection(panelDirection(hingeAxis, "left", physical), direction);
      }
    }
  });

  test("initial tabletop framing is continuous across endpoint angles and ignores display roll", () => {
    for (const pose of ["laptop", "tent"] as const) {
      for (const range of [{ start: 0, end: 31, heldRoll: 0 }, { start: 149, end: 180, heldRoll: Math.PI / 2 }]) {
        let previous: Quaternion | undefined;
        for (let angle = range.start; angle <= range.end; angle++) {
          const previousFrame = { width: 2007, height: 2853, screenId: 3, orientation: "portrait" as const };
          // Metadata can change before the displayed framebuffer. The held
          // roll must prevent it from turning the body underneath that frame.
          const arrivingConfig = { width: 1398, height: 2034, screenId: 1, orientation: "landscape_left" as const };
          const before = duoPose(angle, pose, 3, previousFrame, range.heldRoll);
          const after = duoPose(angle, pose, 1, arrivingConfig, range.heldRoll);
          const current = new Quaternion().setFromEuler(new Euler(...before.rotation, "YXZ"));
          const afterMetadata = new Quaternion().setFromEuler(new Euler(...after.rotation, "YXZ"));
          expect(current.angleTo(afterMetadata)).toBeLessThan(1e-7);
          if (previous) expect(current.angleTo(previous)).toBeLessThan(0.2);
          previous = current;
        }
      }
    }
  });
});

describe("iPhone Duo frame and display matching", () => {
  const cover = { width: 1398, height: 2034, screenId: 1 };
  const inner = { width: 2007, height: 2853, screenId: 3 };

  test("accepts native and pixel-rounded scaled frames for their corresponding panel", () => {
    for (const config of [cover, inner]) {
      expect(duoFrameMatchesDisplay(config.width, config.height, config)).toBe(true);
      for (const height of [1280, 960, 640]) {
        const width = Math.round(config.width / config.height * height);
        expect(duoFrameMatchesDisplay(width, height, config)).toBe(true);
        expect(duoFrameMatchesDisplay(config.width, config.height, { ...config, width, height })).toBe(true);
      }
    }
    expect(duoFrameMatchesDisplay(880, 1280, cover)).toBe(true);
    expect(duoFrameMatchesDisplay(900, 1280, inner)).toBe(true);
  });

  test("rejects the previous panel's frame during both folding and unfolding", () => {
    for (const height of [1280, 960, 640]) {
      const coverWidth = Math.round(cover.width / cover.height * height);
      const innerWidth = Math.round(inner.width / inner.height * height);
      expect(duoFrameMatchesDisplay(coverWidth, height, inner)).toBe(false);
      expect(duoFrameMatchesDisplay(innerWidth, height, cover)).toBe(false);
      expect(duoFrameMatchesDisplay(coverWidth, height, { ...inner, width: innerWidth, height })).toBe(false);
      expect(duoFrameMatchesDisplay(innerWidth, height, { ...cover, width: coverWidth, height })).toBe(false);
    }
    expect(duoFrameMatchesDisplay(cover.width, cover.height, inner)).toBe(false);
    expect(duoFrameMatchesDisplay(inner.width, inner.height, cover)).toBe(false);
  });

  test("rejects missing or invalid frame dimensions while a display is initializing", () => {
    for (const invalid of [0, -1, Number.NaN, Number.POSITIVE_INFINITY]) {
      expect(duoFrameMatchesDisplay(invalid, 1280, cover)).toBe(false);
      expect(duoFrameMatchesDisplay(880, invalid, cover)).toBe(false);
      expect(duoFrameMatchesDisplay(880, 1280, { ...cover, width: invalid })).toBe(false);
      expect(duoFrameMatchesDisplay(880, 1280, { ...cover, height: invalid })).toBe(false);
    }
  });
});

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

  test("Tent targets the outward cover but retained tabletop poses respect slider endpoints", () => {
    for (const nativeScreen of [1, 3]) {
      expect(duoIntendedScreen(80, "tent", nativeScreen)).toBe(1);
      expect(duoIntendedScreen(55, "tent", nativeScreen)).toBe(1);
      expect(duoIntendedScreen(179, "tent", nativeScreen)).toBe(1);
      expect(duoIntendedScreen(90, "laptop", nativeScreen)).toBe(3);
      for (const pose of ["tent", "laptop"] as const) {
        expect(duoIntendedScreen(0, pose, nativeScreen)).toBe(1);
        expect(duoIntendedScreen(180, pose, nativeScreen)).toBe(3);
      }
    }
  });

  test("a half-open device turned face down targets the cover whatever its last preset", () => {
    for (const nativeScreen of [1, 3]) {
      for (const pose of [null, "book", "laptop"] as const) {
        expect(duoIntendedScreen(90, pose, nativeScreen, true)).toBe(1);
        expect(duoIntendedScreen(90, pose, nativeScreen, false)).toBe(3);
        expect(duoIntendedScreen(180, pose, nativeScreen, true)).toBe(3);
        expect(duoIntendedScreen(0, pose, nativeScreen, true)).toBe(1);
      }
    }
  });

  test("uses the native active panel until the hinge angle is known", () => {
    expect(duoIntendedScreen(undefined, "tent", 3)).toBe(3);
    expect(duoIntendedScreen(undefined, "open", 1)).toBe(1);
    expect(duoIntendedScreen(undefined, null, undefined)).toBe(3);
  });
});
