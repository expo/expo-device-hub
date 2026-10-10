import { expect, test } from "bun:test";
import { createLatestClipboardWriter } from "../client/utils/latest-clipboard-write";

test("a newer copy writes after an older browser clipboard write already in flight", async () => {
  const written: string[] = [];
  let releaseFirst!: () => void;
  const firstWrite = new Promise<void>((resolve) => { releaseFirst = resolve; });
  const writer = createLatestClipboardWriter(async (text) => {
    if (text === "old") await firstWrite;
    written.push(text);
  });
  const first = writer.begin();
  const oldWrite = writer.write(first, "old", () => true);
  await Bun.sleep(0);
  const second = writer.begin();
  const newWrite = writer.write(second, "new", () => true);
  releaseFirst();
  expect(await oldWrite).toBe(true);
  expect(await newWrite).toBe(true);
  expect(written).toEqual(["old", "new"]);
});

test("an old copy that finishes its read after a newer one cannot write", async () => {
  const written: string[] = [];
  const writer = createLatestClipboardWriter(async (text) => { written.push(text); });
  const first = writer.begin();
  const second = writer.begin();
  expect(await writer.write(second, "new", () => true)).toBe(true);
  expect(await writer.write(first, "old", () => true)).toBe(false);
  expect(written).toEqual(["new"]);
});
