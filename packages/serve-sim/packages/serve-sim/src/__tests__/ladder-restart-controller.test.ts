import { describe, expect, test } from "bun:test";

import { createLadderRestart } from "../client/hooks/use-ladder-restart";

function harness() {
  const delays: number[] = [];
  const armed = new Map<number, () => void>();
  let next = 0;
  let runs = 0;
  const ladder = createLadderRestart(() => { runs += 1; }, {
    setTimeout: (handler, ms) => { delays.push(ms); armed.set(++next, handler); return next; },
    clearTimeout: (id) => { if (id !== undefined) armed.delete(id); },
  });
  const fire = () => { const [id, handler] = [...armed.entries()][0]!; armed.delete(id); handler(); };
  return { ladder, delays, armed, fire, runs: () => runs };
}

describe("the ladder restart", () => {
  test("arms one restart and runs it", () => {
    const h = harness();
    h.ladder.noteFailure(0);
    h.ladder.schedule();
    expect(h.armed.size).toBe(1);
    h.fire();
    expect(h.runs()).toBe(1);
  });

  /// Two Duo screens fail the same walk. A second arming would cancel the first and take
  /// another step of the backoff, so recovery would give up twice as fast.
  test("a second failure in the same walk rides the pending restart", () => {
    const h = harness();
    h.ladder.noteFailure(0);
    h.ladder.schedule();
    h.ladder.noteFailure(10);
    h.ladder.schedule();
    expect(h.armed.size).toBe(1);
    expect(h.delays).toEqual([2_000]);
  });

  test("the delay grows once per walk, not once per failure", () => {
    const h = harness();
    for (let walk = 0; walk < 4; walk++) {
      h.ladder.noteFailure(walk * 1_000);
      h.ladder.schedule();
      h.ladder.noteFailure(walk * 1_000 + 10);
      h.ladder.schedule();
      h.fire();
    }
    expect(h.delays).toEqual([2_000, 4_000, 8_000, 16_000]);
  });

  test("a cancelled restart never runs, and the next one still arms", () => {
    const h = harness();
    h.ladder.noteFailure(0);
    h.ladder.schedule();
    h.ladder.cancel();
    expect(h.armed.size).toBe(0);
    h.ladder.noteFailure(1_000);
    h.ladder.schedule();
    expect(h.armed.size).toBe(1);
    h.fire();
    expect(h.runs()).toBe(1);
  });

  test("a restart that has run does not block the next one", () => {
    const h = harness();
    h.ladder.noteFailure(0);
    h.ladder.schedule();
    h.fire();
    h.ladder.noteFailure(1_000);
    h.ladder.schedule();
    expect(h.armed.size).toBe(1);
  });
});
