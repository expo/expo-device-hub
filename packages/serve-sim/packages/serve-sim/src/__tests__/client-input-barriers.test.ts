import { expect, test } from "bun:test";
import { createInputBarriers } from "../socket/client-input-barriers";

test("a late acknowledgment cannot complete the next Copy after a timeout", async () => {
  const sent: number[] = [];
  const connection = {};
  const barriers = createInputBarriers((_connection, id) => { sent.push(id); return true; }, 10);
  await expect(barriers.wait(connection)).rejects.toThrow("did not finish in time");
  const next = barriers.wait(connection);
  expect(sent).toEqual([1, 2]);
  expect(barriers.receive(connection, { requestId: 1, ok: true })).toBe(false);
  expect(barriers.receive(connection, { requestId: 2, ok: true })).toBe(true);
  await next;
});

test("reconnect cancels old Copy work and ignores its acknowledgments", async () => {
  const barriers = createInputBarriers(() => true);
  const oldConnection = {};
  const currentConnection = {};
  const old = barriers.wait(oldConnection);
  barriers.cancel();
  await expect(old).rejects.toThrow("disconnected");
  const current = barriers.wait(currentConnection);
  expect(barriers.receive(currentConnection, { requestId: 1, ok: true })).toBe(false);
  expect(barriers.receive(oldConnection, { requestId: 2, ok: true })).toBe(false);
  expect(barriers.receive(currentConnection, { requestId: 2, ok: true })).toBe(true);
  await current;
});

test("Copy fails when input is unadmitted or the barrier cannot be sent", async () => {
  let attempts = 0;
  const barriers = createInputBarriers(() => { attempts++; return false; });
  await expect(barriers.wait(null)).rejects.toThrow("disconnected");
  expect(attempts).toBe(0);
  await expect(barriers.wait({})).rejects.toThrow("disconnected");
  expect(attempts).toBe(1);
});

test("malformed replies do not consume a barrier and failed input rejects Copy", async () => {
  const barriers = createInputBarriers(() => true);
  const connection = {};
  const waiting = barriers.wait(connection);
  for (const reply of [null, true, { ok: true }, { requestId: 1, ok: 1 }]) {
    expect(barriers.receive(connection, reply)).toBe(false);
  }
  expect(barriers.receive(connection, { requestId: 1, ok: false })).toBe(true);
  await expect(waiting).rejects.toThrow("Simulator input failed");
});
