import { expect, test } from "bun:test";
import { EMPTY_LOG_ROWS, updateLogRows } from "../client/utils/log-rows";
import { parseLogSnapshot } from "../client/utils/logs-poll";

const batch = (count: number) => parseLogSnapshot({ latestSeq: count,
  lines: Array.from({ length: count }, (_, seq) => ({ seq, raw: JSON.stringify({eventMessage: String(seq)}) })),
})!.lines;

test("paused rows are bounded and resume in order without replacing visible rows early", () => {
  let state = updateLogRows(EMPTY_LOG_ROWS, { type: "append", batch: batch(1) });
  state = updateLogRows(state, { type: "toggle-pause" });
  state = updateLogRows(state, { type: "append", batch: batch(2001) });
  expect(state.lines.map((line) => line.id)).toEqual([1]);
  expect(state.held).toHaveLength(2000);
  state = updateLogRows(state, { type: "toggle-pause" });
  expect(state.lines).toHaveLength(2000);
  expect(state.lines[0]?.id).toBe(3);
  expect(state.lines.at(-1)?.id).toBe(2002);
  expect(state.held).toEqual([]);
});

test("clearing paused logs also discards held rows and preserves unique row ids", () => {
  let state = updateLogRows(EMPTY_LOG_ROWS, { type: "toggle-pause" });
  state = updateLogRows(state, { type: "append", batch: batch(2) });
  state = updateLogRows(state, { type: "clear" });
  state = updateLogRows(state, { type: "toggle-pause" });
  expect(state.lines).toEqual([]);
  state = updateLogRows(state, { type: "append", batch: batch(1) });
  expect(state.lines[0]?.id).toBe(3);
  expect(updateLogRows(state, { type: "reset" })).toEqual(EMPTY_LOG_ROWS);
});
