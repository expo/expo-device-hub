import { expect, test } from "bun:test";

import { FOLD_POSE_OPTIONS } from "../dashboard/foldPoses";

test("each fold pose shows the Option+Shift digit that the keyboard sends for it", () => {
  expect(
    Object.fromEntries(FOLD_POSE_OPTIONS.map(({ value, shortcut }) => [value, shortcut])),
  ).toEqual({
    closed: "⌥⇧1",
    open: "⌥⇧2",
    laptop: "⌥⇧3",
    book: "⌥⇧4",
    tent: "⌥⇧5",
  });
});
