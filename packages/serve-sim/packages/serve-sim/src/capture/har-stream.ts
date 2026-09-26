import { createReadStream, createWriteStream } from "node:fs";
import type { WriteStream } from "node:fs";
import { open as openFile, rename, unlink } from "node:fs/promises";
import { createInterface } from "node:readline";
import { once } from "node:events";
import { finished } from "node:stream/promises";

import { emptyHar } from "./har";
import { clearTempPath } from "./no-follow";

export function emptyHarText(creatorVersion: string): string {
  return `${JSON.stringify(emptyHar(creatorVersion))}\n`;
}

function harEnvelope(creatorVersion: string): { open: Buffer; close: Buffer } {
  const json = JSON.stringify(emptyHar(creatorVersion));
  const marker = '"entries":[]';
  const at = json.indexOf(marker);
  if (at < 0) {
    throw new Error("emptyHar() shape changed; cannot build streaming HAR envelope");
  }
  // `"entries":[]` → open through `[`, close from the array's `]` through the root `}`.
  return {
    open: Buffer.from(`${json.slice(0, at)}"entries":[`),
    close: Buffer.from(`${json.slice(at + marker.length - 1)}\n`),
  };
}

export async function writeChunk(stream: WriteStream, chunk: string | Buffer): Promise<void> {
  if (stream.destroyed) {
    throw stream.errored ?? new Error("HAR output stream closed before writing finished.");
  }
  if (!stream.write(chunk)) {
    await once(stream, "drain");
  }
}

function observeCompletion(stream: WriteStream): Promise<void> {
  const done = finished(stream);
  // Observe early failures while the caller is still reading or writing.
  void done.catch(() => {});
  return done;
}

async function streamHarBody(
  outPath: string,
  creatorVersion: string,
  writeEntries: (out: WriteStream) => Promise<void>,
): Promise<void> {
  const { open, close } = harEnvelope(creatorVersion);
  const tmp = `${outPath}.${process.pid}.tmp`;
  clearTempPath(tmp);
  const out = createWriteStream(tmp, { flags: "wx" });
  const done = observeCompletion(out);
  try {
    await writeChunk(out, open);
    await writeEntries(out);
    await writeChunk(out, close);
    out.end();
    await done;
    await rename(tmp, outPath);
  } catch (err) {
    out.destroy();
    await Promise.allSettled([done]);
    await unlink(tmp).catch(() => {});
    throw err;
  }
}

interface IndexedLine {
  start: number;
  offset: number;
  length: number;
}

/** Each non-empty line's start time and byte range, read a chunk at a time. */
async function indexEntryLines(entriesPath: string): Promise<IndexedLine[]> {
  const index: IndexedLine[] = [];
  let offset = 0;
  let pending: Buffer[] = [];
  let pendingStart = 0;
  const finishLine = (end: number) => {
    const line = Buffer.concat(pending);
    pending = [];
    if (line.length > 0) {
      let start = Number.POSITIVE_INFINITY;
      try {
        const parsed = Date.parse((JSON.parse(line.toString("utf8")) as { startedDateTime?: string }).startedDateTime ?? "");
        if (!Number.isNaN(parsed)) start = parsed;
      } catch {
        // An unreadable line keeps its place after the dated ones.
      }
      index.push({ start, offset: pendingStart, length: end - pendingStart });
    }
  };
  for await (const chunk of createReadStream(entriesPath) as AsyncIterable<Buffer>) {
    let from = 0;
    for (let at = chunk.indexOf(10); at !== -1; at = chunk.indexOf(10, from)) {
      pending.push(chunk.subarray(from, at));
      finishLine(offset + at);
      from = at + 1;
      pendingStart = offset + from;
    }
    if (from < chunk.length) pending.push(chunk.subarray(from));
    offset += chunk.length;
  }
  finishLine(offset);
  return index;
}

/**
 * Stream-rebuild a HAR from an NDJSON file of HarEntry lines, in start order as HAR readers
 * expect. The log holds entries by completion time; only a small index is kept in memory.
 */
export async function streamHarFromNdjsonFile(
  entriesPath: string,
  outPath: string,
  creatorVersion: string,
): Promise<void> {
  const index = (await indexEntryLines(entriesPath)).sort((a, b) => a.start - b.start);
  await streamHarBody(outPath, creatorVersion, async (out) => {
    const file = await openFile(entriesPath, "r");
    try {
      for (let i = 0; i < index.length; i++) {
        const { offset, length } = index[i]!;
        const line = Buffer.alloc(length);
        await file.read(line, 0, length, offset);
        if (i > 0) await writeChunk(out, ",");
        await writeChunk(out, line);
      }
    } finally {
      await file.close();
    }
  });
}

/** Keep the newest maxEntries lines, rebuild HAR, and return the retained count. */
export async function compactNdjsonAndStreamHar(
  entriesPath: string,
  harPath: string,
  creatorVersion: string,
  maxEntries: number,
): Promise<number> {
  let currentCount = 0;
  {
    const input = createReadStream(entriesPath, { encoding: "utf8" });
    const lines = createInterface({ input, crlfDelay: Infinity });
    try {
      for await (const line of lines) {
        if (line) currentCount += 1;
      }
    } finally {
      lines.close();
      input.destroy();
    }
  }

  if (currentCount <= maxEntries) {
    await streamHarFromNdjsonFile(entriesPath, harPath, creatorVersion);
    return currentCount;
  }

  const skip = currentCount - maxEntries;
  const entriesTmp = `${entriesPath}.${process.pid}.compact.tmp`;
  clearTempPath(entriesTmp);
  const entriesOut = createWriteStream(entriesTmp, { flags: "wx" });
  const entriesDone = observeCompletion(entriesOut);
  let skipped = 0;
  let kept = 0;
  const input = createReadStream(entriesPath, { encoding: "utf8" });
  const lines = createInterface({ input, crlfDelay: Infinity });
  try {
    for await (const line of lines) {
      if (!line) continue;
      if (skipped < skip) {
        skipped += 1;
        continue;
      }
      await writeChunk(entriesOut, `${line}\n`);
      kept += 1;
    }
    entriesOut.end();
    await entriesDone;
    await rename(entriesTmp, entriesPath);
  } catch (err) {
    entriesOut.destroy();
    await Promise.allSettled([entriesDone]);
    await unlink(entriesTmp).catch(() => {});
    throw err;
  } finally {
    lines.close();
    input.destroy();
  }
  // The HAR is rebuilt from the compacted log, in start order.
  await streamHarFromNdjsonFile(entriesPath, harPath, creatorVersion);
  return kept;
}
