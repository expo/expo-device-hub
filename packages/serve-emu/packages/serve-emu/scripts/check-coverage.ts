const CRITICAL_SOURCE_FILES = [
  "src/server.ts",
  "src/server/backpressure.ts",
  "src/server/session-cache.ts",
  "src/server/session-scope.ts",
  "src/scrcpy.ts",
  "src/input.ts",
  "src/route-playback.ts",
  "src/session-recorder.ts",
  "src/stream-settings.ts",
  "src/webrtc-publisher.ts",
  "src/webrtc-signaling.ts",
  "src/ui/lib/poller.ts",
  "src/ui/lib/webrtc-negotiation.ts",
  "src/ui/lib/stream-state.ts",
] as const;

const lcovFile = Bun.file(new URL("../coverage/lcov.info", import.meta.url));
if (!(await lcovFile.exists())) {
  console.error("coverage/lcov.info was not generated");
  process.exit(1);
}

const records = (await lcovFile.text())
  .split("end_of_record")
  .map((record) => {
    const source = record.match(/^SF:(.+)$/m)?.[1]?.replaceAll("\\", "/");
    const linesFound = Number(record.match(/^LF:(\d+)$/m)?.[1] ?? "0");
    return { source, linesFound };
  })
  .filter((record) => record.source);

const missing = CRITICAL_SOURCE_FILES.filter(
  (required) =>
    !records.some(
      (record) =>
        record.source?.endsWith(required) && record.linesFound > 0,
    ),
);

if (missing.length > 0) {
  console.error(
    `coverage is missing critical source modules:\n${missing
      .map((file) => `- ${file}`)
      .join("\n")}`,
  );
  process.exit(1);
}

console.log(
  `coverage includes all ${CRITICAL_SOURCE_FILES.length} critical source modules`,
);
