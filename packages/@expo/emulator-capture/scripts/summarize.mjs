import { readFile } from "node:fs/promises";
import { pathToFileURL } from "node:url";

// The native writer emits a fixed numeric CSV, with no quoted fields.
export function summarize(csv, file) {
  const [header, ...lines] = csv.trim().split(/\r?\n/);
  const columns = header.split(",");
  const fields = ["elapsed_ms", "capture_ms", "copy_ms"];
  if (fields.some(field => !columns.includes(field)))
    throw new Error("Capture CSV must contain elapsed_ms, capture_ms and copy_ms");
  const rows = lines.map(line => {
    const values = line.split(",");
    return Object.fromEntries(fields.map(field => {
      const value = values[columns.indexOf(field)];
      if (value === undefined || value.trim() === "" || !Number.isFinite(Number(value)))
        throw new Error(`Invalid ${field} in capture CSV`);
      return [field, Number(value)];
    }));
  });
  // Ignore startup frames when measuring steady-state capture performance.
  const warmupFrames = 10;
  const measured = rows.slice(warmupFrames);
  if (measured.length < 2) throw new Error("Need at least 12 captured frames");
  const elapsedMilliseconds = measured.at(-1).elapsed_ms - measured[0].elapsed_ms;
  if (elapsedMilliseconds <= 0) throw new Error("Capture timestamps must advance");
  const result = {
    file,
    captured_frames: rows.length,
    warmup_excluded: warmupFrames,
    measured_fps: (measured.length - 1) * 1000 / elapsedMilliseconds,
  };

  // Summarize CPU wall times around capture and GPU copy submission/completion.
  for (const key of ["capture_ms", "copy_ms"]) {
    const values = measured.map(row => row[key]).sort((a, b) => a - b);
    const middle = Math.floor(values.length / 2);
    const mean = values.reduce((sum, value) => sum + value, 0) / values.length;
    const median = values.length % 2 ? values[middle] : (values[middle - 1] + values[middle]) / 2;
    const p95Index = Math.floor((values.length - 1) * 0.95);
    const p99Index = Math.floor((values.length - 1) * 0.99);
    result[key] = {
      mean,
      p50: median,
      p95: values[p95Index],
      p99: values[p99Index],
      max: values.at(-1),
    };
  }
  return result;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  if (process.argv.length < 3) throw new Error("Usage: npm run eval:summarize -- CAPTURE.csv [...]");
  for (const filePath of process.argv.slice(2)) {
    const csv = await readFile(filePath, "utf8");
    const summary = summarize(csv, filePath);
    console.log(JSON.stringify(summary, null, 2));
  }
}
