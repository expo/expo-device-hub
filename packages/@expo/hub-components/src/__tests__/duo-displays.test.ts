import { expect, test } from "bun:test";

// hub-client does not export its iPhone Duo panel map, so the test reads its source.
import {
  DUO_DISPLAY_FOR_PANEL as CLIENT_DISPLAY_FOR_PANEL,
  DUO_PANEL_FOR_DISPLAY as CLIENT_PANEL_FOR_DISPLAY,
} from "../../../hub-client/src/duo/duo-fold";
import { DUO_PANEL_FOR_DISPLAY, duoDisplayId } from "../foldable/duo-displays";

test("the model's panel IDs match hub-client's copy and round-trip", () => {
  expect(DUO_PANEL_FOR_DISPLAY).toEqual(CLIENT_PANEL_FOR_DISPLAY);
  for (const panel of [1, 3] as const) {
    const display = CLIENT_DISPLAY_FOR_PANEL[panel];
    expect(duoDisplayId(panel)).toBe(display);
    expect(DUO_PANEL_FOR_DISPLAY[display]).toBe(panel);
  }
  expect(duoDisplayId(2)).toBeUndefined();
});
