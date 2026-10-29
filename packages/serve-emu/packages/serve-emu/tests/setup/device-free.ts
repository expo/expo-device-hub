import { mock } from "bun:test";

import * as displayOrientation from "../../src/display-orientation.ts";

// serve-emu tests run without a device (CONTRIBUTING.md). `/api` and `/health` report the
// display orientation through the shared per-serial reader, which runs adb, so the default
// suite gets a reader that never reads. Tests that need a reading inject their own, and
// `createDisplayOrientationReader` stays real for its unit tests.
mock.module("../../src/display-orientation.ts", () => ({
  ...displayOrientation,
  displayOrientationReader: (): displayOrientation.DisplayOrientationReader => ({
    current: () => null,
    fresh: async () => null,
    refresh: async () => null,
    locked: () => {},
  }),
}));
