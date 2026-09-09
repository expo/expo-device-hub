import { describe, expect, test } from "bun:test";
import {
  LogcatBatchPublisher,
  LogcatRingBuffer,
  type LogcatBufferSnapshot,
  type LogcatEntry,
} from "../src/ui/lib/logcat-buffer.ts";

const log = (line: string, at = ""): LogcatEntry => ({ line, at });

describe("LogcatRingBuffer", () => {
  test("drops the oldest lines when the line limit is reached", () => {
    const buffer = new LogcatRingBuffer({ maxLines: 3, maxBytes: 1_024 });

    expect(buffer.append([log("one"), log("two"), log("three"), log("four")])).toEqual({
      appended: 4,
      dropped: 1,
    });
    expect(buffer.snapshot()).toEqual({
      lines: [log("two"), log("three"), log("four")],
      text: "two\nthree\nfour",
      count: 3,
      bytes: 14,
      dropped: 1,
    });
  });

  test("enforces the UTF-8 byte limit while retaining the newest lines", () => {
    const buffer = new LogcatRingBuffer({ maxLines: 10, maxBytes: 6 });

    buffer.append([log("éé"), log("a")]);
    expect(buffer.snapshot().text).toBe("éé\na");
    expect(buffer.snapshot().bytes).toBe(6);

    expect(buffer.append([log("xy")])).toEqual({ appended: 1, dropped: 1 });
    expect(buffer.snapshot()).toMatchObject({
      lines: [log("a"), log("xy")],
      text: "a\nxy",
      bytes: 4,
      dropped: 1,
    });
  });

  test("drops an oversized line without evicting buffered content", () => {
    const buffer = new LogcatRingBuffer({ maxLines: 4, maxBytes: 5 });
    buffer.append([log("ok")]);

    expect(buffer.append([log("123456")])).toEqual({ appended: 0, dropped: 1 });
    expect(buffer.snapshot()).toMatchObject({
      lines: [log("ok")],
      bytes: 2,
      dropped: 1,
    });
  });

  test("reuses cached snapshots and clear retains the lifetime drop count", () => {
    const buffer = new LogcatRingBuffer({ maxLines: 1, maxBytes: 10 });
    buffer.append([log("old"), log("new")]);
    const first = buffer.snapshot();

    expect(buffer.snapshot()).toBe(first);
    buffer.clear();

    const cleared = buffer.snapshot();
    expect(cleared).not.toBe(first);
    expect(cleared).toEqual({
      lines: [],
      text: "",
      count: 0,
      bytes: 0,
      dropped: 1,
    });
    expect(buffer.snapshot()).toBe(cleared);
  });

  test("accounts for timestamps in the byte bound", () => {
    const buffer = new LogcatRingBuffer(3, 5);

    expect(buffer.append([log("a", "1234")])).toEqual({
      appended: 1,
      dropped: 0,
    });
    expect(buffer.snapshot().bytes).toBe(5);
    expect(buffer.append([log("b", "12345")])).toEqual({
      appended: 0,
      dropped: 1,
    });
    expect(buffer.snapshot().lines).toEqual([log("a", "1234")]);
  });

  test("rejects invalid limits", () => {
    expect(() => new LogcatRingBuffer({ maxLines: 0 })).toThrow(RangeError);
    expect(() => new LogcatRingBuffer({ maxBytes: 1.5 })).toThrow(RangeError);
  });
});

describe("LogcatBatchPublisher", () => {
  test("coalesces many appends into one scheduled snapshot", () => {
    let nextHandle = 1;
    const callbacks = new Map<number, () => void>();
    const published: LogcatBufferSnapshot[] = [];
    const buffer = new LogcatRingBuffer();
    const publisher = new LogcatBatchPublisher(
      buffer,
      (snapshot) => published.push(snapshot),
      (callback) => {
        const handle = nextHandle++;
        callbacks.set(handle, callback);
        return handle;
      },
      (handle) => callbacks.delete(handle),
    );

    publisher.append([log("one")]);
    publisher.append([log("two"), log("three")]);
    publisher.append([log("four")]);

    expect(callbacks.size).toBe(1);
    expect(published).toHaveLength(0);
    callbacks.get(1)!();
    callbacks.delete(1);

    expect(published).toHaveLength(1);
    expect(published[0].text).toBe("one\ntwo\nthree\nfour");

    publisher.append([log("five")]);
    expect(callbacks.size).toBe(1);
  });

  test("clear shares a pending frame and publishes an empty snapshot", () => {
    const callbacks = new Map<number, () => void>();
    const published: LogcatBufferSnapshot[] = [];
    const publisher = new LogcatBatchPublisher(
      new LogcatRingBuffer(),
      (snapshot) => published.push(snapshot),
      (callback) => {
        callbacks.set(1, callback);
        return 1;
      },
      (handle) => callbacks.delete(handle),
    );

    publisher.append([log("line")]);
    publisher.clear();
    expect(callbacks.size).toBe(1);

    callbacks.get(1)!();
    expect(published).toHaveLength(1);
    expect(published[0].text).toBe("");
  });

  test("flush cancels pending work and dispose prevents future work", () => {
    let nextHandle = 1;
    const callbacks = new Map<number, () => void>();
    const canceled: number[] = [];
    const published: LogcatBufferSnapshot[] = [];
    const buffer = new LogcatRingBuffer();
    const publisher = new LogcatBatchPublisher(
      buffer,
      (snapshot) => published.push(snapshot),
      (callback) => {
        const handle = nextHandle++;
        callbacks.set(handle, callback);
        return handle;
      },
      (handle) => {
        canceled.push(handle);
        callbacks.delete(handle);
      },
    );

    publisher.append([log("line")]);
    publisher.flush();
    expect(canceled).toEqual([1]);
    expect(callbacks.size).toBe(0);
    expect(published.map((snapshot) => snapshot.text)).toEqual(["line"]);

    publisher.append([log("later")]);
    publisher.dispose();
    expect(canceled).toEqual([1, 2]);
    publisher.append([log("ignored")]);
    publisher.clear();
    publisher.flush();

    expect(callbacks.size).toBe(0);
    expect(published).toHaveLength(1);
    expect(buffer.snapshot().text).toBe("line\nlater");
  });
});
