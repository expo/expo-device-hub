import { describe, expect, test } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";

import { StreamStatsBody, describeFaults, statsToJson } from "../client/components/stream-stats-tool";
import type { CaptureCounts } from "../webrtc-sender-stats";
import type { CaptureWindow } from "../client/utils/capture-window";
import type { StreamStats } from "../client/utils/webrtc-stats";

function stats(overrides: Partial<StreamStats> = {}): StreamStats {
  return {
    atMs: 0,
    framesDecoded: 0,
    framesDropped: 0,
    freezeCount: 0,
    freezeMs: 0,
    bytesReceived: 0,
    packetsReceived: 0,
    packetsLost: 0,
    jitterMs: 8,
    jitterBufferSeconds: 4,
    jitterBufferEmitted: 100,
    reportedFps: 60,
    interFrameDelaySeconds: null,
    interFrameDelaySquaredSeconds: null,
    decodeSeconds: null,
    pacingDeviationMs: null,
    frameGapMs: null,
    decodeMsPerFrame: null,
    width: 1280,
    height: 720,
    codec: "video/VP8",
    roundTripMs: 30,
    path: "direct",
    fps: 60,
    kbps: 2800,
    lossRatio: 0,
    droppedInWindow: 0,
    freezesInWindow: 0,
    freezeMsInWindow: 0,
    jitterBufferMs: 40,
    ...overrides,
  };
}

/** The value shown for one labelled row, so a styling change does not read as a regression. */
function row(markup: string, label: string): string | null {
  const attribute = markup.indexOf(`data-stream-stat="${label}"`);
  if (attribute === -1) return null;
  const value = markup.indexOf("data-stream-value", attribute);
  if (value === -1) return null;
  const start = markup.indexOf(">", value) + 1;
  const cell = markup.slice(start, markup.indexOf("</span>", start));
  return cell.replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").trim();
}

/** The hover description for one labelled row, which carries the meaning and the scope. */
function help(markup: string, label: string): string | null {
  const attribute = markup.indexOf(`data-stream-stat="${label}"`);
  if (attribute === -1) return null;
  const tip = markup.indexOf('role="tooltip"', attribute);
  if (tip === -1) return null;
  const start = markup.indexOf(">", tip) + 1;
  const body = markup.slice(start, markup.indexOf("</span></span>", start));
  return body.replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").trim();
}

/** The last line of a tooltip, which states the window the number covers. */
function scopeOf(markup: string, label: string): string {
  const body = help(markup, label) ?? "";
  const scopes = [
    "Last second", "Now", "Average per frame, this session",
    "Average per frame, last second", "Since the session started",
  ];
  return scopes.find((scope) => body.endsWith(scope)) ?? "";
}

const sender = {
  sessionId: "s", codec: "VP8", connected: true,
  qualityLimitationReason: "none", qualityLimitationMs: {},
  framesEncoded: 100, framesSent: 100, reportedFps: 30, targetKbps: 3000,
  totalEncodeMs: 240, encodeMsPerFrame: 2.4, width: 589, height: 1280,
  packetsSent: 900, packetsLost: 0, lossRatio: 0, roundTripMs: 20,
  path: "direct" as const, sourceFrames: 120, sourceFps: 30, sourceFramesDropped: 0,
};

describe("describeFaults", () => {
  test("says nothing about a healthy window", () => {
    expect(describeFaults(stats())).toEqual([]);
  });

  test("counts freezes with the time lost in the same window", () => {
    expect(describeFaults(stats({ freezesInWindow: 2, freezeMsInWindow: 1_500 })))
      .toEqual(["2 freezes (1.5s)"]);
  });

  test("uses the singular for one freeze", () => {
    expect(describeFaults(stats({ freezesInWindow: 1, freezeMsInWindow: 400 })))
      .toEqual(["1 freeze (0.4s)"]);
  });

  test("omits the duration when only the count is known", () => {
    expect(describeFaults(stats({ freezesInWindow: 1, freezeMsInWindow: 0 })))
      .toEqual(["1 freeze"]);
  });

  test("reports dropped frames", () => {
    expect(describeFaults(stats({ droppedInWindow: 12 }))).toEqual(["12 frames dropped"]);
  });

  test("ignores packet loss below the threshold", () => {
    expect(describeFaults(stats({ lossRatio: 0.01 }))).toEqual([]);
  });

  test("reports packet loss above the threshold", () => {
    expect(describeFaults(stats({ lossRatio: 0.05 }))).toEqual(["5.0% packet loss"]);
  });

  test("says nothing when a reading is unavailable", () => {
    expect(describeFaults(stats({
      freezesInWindow: null,
      droppedInWindow: null,
      lossRatio: null,
    }))).toEqual([]);
  });

  test("says a CPU-bound encoder cannot keep up, rather than printing the reason code", () => {
    expect(describeFaults(stats(), { ...sender, qualityLimitationReason: "cpu" }))
      .toEqual(["Encoder cannot keep up (CPU)"]);
  });

  test("blames the network, not the encoder, when bandwidth is the limit", () => {
    expect(describeFaults(stats(), { ...sender, qualityLimitationReason: "bandwidth" }))
      .toEqual(["Bitrate reduced by the network"]);
  });

  test("keeps an unfamiliar reason code out of the UI", () => {
    expect(describeFaults(stats(), { ...sender, qualityLimitationReason: "other" }))
      .toEqual(["Encoder holding back (reason unknown)"]);
  });

  test("says nothing when the encoder is not holding back", () => {
    expect(describeFaults(stats(), sender)).toEqual([]);
  });

  test("keeps the source's lifetime drop count out of a per-window list", () => {
    expect(describeFaults(stats(), { ...sender, sourceFramesDropped: 7 })).toEqual([]);
  });

  test("works without the sender half", () => {
    expect(describeFaults(stats(), null)).toEqual([]);
  });

  test("lists every fault at once", () => {
    expect(describeFaults(stats({ freezesInWindow: 1, droppedInWindow: 4, lossRatio: 0.1 })))
      .toHaveLength(3);
  });
});

describe("StreamStatsBody", () => {
  test("keeps a healthy window quiet rather than printing zeros", () => {
    const markup = renderToStaticMarkup(<StreamStatsBody stats={stats()} history={[stats()]} faults={describeFaults(stats())} />);
    expect(markup).toContain("No drops, freezes or loss in this window");
    expect(markup).not.toContain("text-warning");
  });

  test("files the all-clear behind the disclosure, since a quiet stream needs no line", () => {
    const markup = renderToStaticMarkup(<StreamStatsBody stats={stats()} history={[stats()]} faults={[]} />);
    const [before] = markup.split("Diagnostics");
    expect(before).not.toContain("No drops");
  });

  test("puts a fault where the all-clear would be, so one slot carries the verdict", () => {
    const dropping = stats({ droppedInWindow: 3 });
    const markup = renderToStaticMarkup(
      <StreamStatsBody stats={dropping} history={[stats()]} faults={describeFaults(dropping)} />,
    );
    const [before, inside] = markup.split("Diagnostics");
    expect(before).not.toContain("3 frames dropped");
    expect(inside).toContain("3 frames dropped");
    expect(markup).not.toContain("No drops");
  });

  test("does not claim health for a window it could not measure", () => {
    const unmeasured = stats({
      fps: null, kbps: null, lossRatio: null, droppedInWindow: null,
      freezesInWindow: null, freezeMsInWindow: null,
    });
    const markup = renderToStaticMarkup(
      <StreamStatsBody stats={unmeasured} history={[unmeasured]} faults={describeFaults(unmeasured)} />,
    );
    expect(markup).toContain("Measuring…");
    expect(markup).not.toContain("No drops");
  });

  test("leaves an unmeasured window out of the graph instead of plotting a zero", () => {
    const history = [stats({ fps: 30 }), stats({ fps: null }), stats({ fps: 30 })];
    const markup = renderToStaticMarkup(
      <StreamStatsBody stats={stats()} history={history} faults={[]} />,
    );
    // Two real points draw a flat line; a coalesced zero between them would dip to the baseline.
    expect(markup).not.toContain("24.0");
  });

  test("shows a fractional frame rate so a limping stream is not a dead one", () => {
    const markup = renderToStaticMarkup(
      <StreamStatsBody stats={stats({ fps: 0.4 })} history={[stats()]} faults={describeFaults(stats({ fps: 0.4 }))} />,
    );
    expect(row(markup, "Frame rate")).toBe("0.4 fps");
  });

  test("shows the faults instead of the all-clear line", () => {
    const markup = renderToStaticMarkup(
      <StreamStatsBody stats={stats({ droppedInWindow: 3 })} history={[stats()]} faults={describeFaults(stats({ droppedInWindow: 3 }))} />,
    );
    expect(markup).toContain("3 frames dropped");
    expect(markup).toContain("text-warning");
    expect(markup).not.toContain("No drops");
  });

  test("renders a dash without its unit when a reading is unavailable", () => {
    const markup = renderToStaticMarkup(
      <StreamStatsBody
        stats={stats({ fps: null, kbps: null, roundTripMs: null, jitterBufferMs: null })}
        history={[stats()]}
        faults={[]}
      />,
    );
    expect(row(markup, "Frame rate")).toBe("—");
    expect(row(markup, "Bitrate")).toBe("—");
    expect(row(markup, "RTT")).toBe("—");
    expect(row(markup, "Jitter buffer")).toBe("—");
    expect(markup).not.toContain("— ms");
  });

  test("shows the frame rate against the requested one", () => {
    const markup = renderToStaticMarkup(
      <StreamStatsBody stats={stats({ fps: 24 })} history={[stats()]} faults={describeFaults(stats({ fps: 24 }))} requestedFps={60} />,
    );
    expect(row(markup, "Frame rate")).toBe("24 fps of 60");
  });

  test("keeps a limping stream distinguishable from a dead one", () => {
    const markup = renderToStaticMarkup(
      <StreamStatsBody stats={stats({ kbps: 4 })} history={[stats()]} faults={describeFaults(stats({ kbps: 4 }))} />,
    );
    expect(row(markup, "Bitrate")).toBe("4 kbps");
  });

  test("names a relayed route in words rather than an ICE term", () => {
    const markup = renderToStaticMarkup(
      <StreamStatsBody stats={stats({ path: "relay" })} history={[stats()]} faults={describeFaults(stats({ path: "relay" }))} />,
    );
    expect(row(markup, "ICE route")).toBe("Via relay");
  });

  test("hides the route when it cannot be determined", () => {
    const markup = renderToStaticMarkup(
      <StreamStatsBody stats={stats({ path: "unknown" })} history={[stats()]} faults={describeFaults(stats({ path: "unknown" }))} />,
    );
    expect(row(markup, "ICE route")).toBeNull();
  });

  test("shows the sender's encode cost with the other secondary values", () => {
    const markup = renderToStaticMarkup(
      <StreamStatsBody stats={stats()} history={[stats()]} faults={[]} sender={sender} />,
    );
    expect(row(markup, "Encode")).toBe("2.4 ms");
    expect(help(markup, "Encode")).toContain("Average per frame");
  });

  test("omits the encode cost without the sender half", () => {
    const markup = renderToStaticMarkup(
      <StreamStatsBody stats={stats()} history={[stats()]} faults={[]} />,
    );
    expect(row(markup, "Encode")).toBeNull();
  });

  test("draws a sparkline from the recorded values, not an empty box", () => {
    const history = [stats({ fps: 10, kbps: 500 }), stats({ fps: 60, kbps: 2_800 })];
    const markup = renderToStaticMarkup(
      <StreamStatsBody stats={stats()} history={history} faults={[]} />,
    );
    const paths = [...markup.matchAll(/ d="([^"]+)"/g)].map((match) => match[1]);
    expect(paths).toHaveLength(4);
    // Two different series must not draw the same shape.
    expect(new Set(paths).size).toBeGreaterThan(1);
  });
});

/** The download keeps the raw lifetime counters; only the panel reads the window. */
const captureCounts: CaptureCounts = {
  pickCount: 5400, pickSumMs: 53, pickMaxMs: 0.8,
  screenFrames: 900, idleFrames: 12, offeredFrames: 880, forwardedFrames: 830,
  pumpRestarts: 0, cpuFallbacks: 0, attempts: 5400, stalls: 0, gapSumMs: 90_000,
  stallSumMs: 0, pollTicks: 2400, pollLateSumMs: 600,
};

const capture: CaptureWindow = {
  screenFps: 60, idleFps: 0, deliveredFps: 60, submittedFps: 60, intervalMs: 8.3, pickMs: 0.01,
  stalls: 0, stallSumMs: 0, cpuFallbacks: 0, pumpRestarts: 0,
};

describe("stale samples", () => {
  test("says samples stopped instead of showing the last one as live", () => {
    const markup = renderToStaticMarkup(
      <StreamStatsBody stats={stats()} history={[stats()]} faults={[]} stale />,
    );
    expect(markup).toContain("No samples in the last few seconds");
    expect(markup).not.toContain("No drops, freezes or loss");
  });

  test("keeps the sender half visible when only the receiver went quiet", () => {
    const markup = renderToStaticMarkup(
      <StreamStatsBody
        stats={stats()}
        history={[stats()]}
        faults={[]}
        sender={sender}
        capture={capture}
        stale
      />,
    );
    expect(row(markup, "Encode")).toBe("2.4 ms");
    expect(row(markup, "Screen frames")).toBe("60/s");
    expect(markup).toContain("opacity-50");
  });

  test("dims the readout it can no longer vouch for", () => {
    const markup = renderToStaticMarkup(
      <StreamStatsBody
        stats={stats()}
        history={[stats()]}
        faults={[]}
        sender={sender}
        capture={capture}
        stale
      />,
    );
    expect(markup).toContain("opacity-50");
  });
});

describe("diagnostics", () => {
  test("keeps the detail behind a disclosure, so the default read stays short", () => {
    const markup = renderToStaticMarkup(
      <StreamStatsBody
        stats={stats()}
        history={[stats()]}
        faults={[]}
        sender={sender}
        capture={capture}
      />,
    );
    const [before, inside] = markup.split("Diagnostics");
    expect(before).toContain("Frame gap");
    expect(before).not.toContain("Screen frames");
    expect(inside).toContain("No drops, freezes or loss in this window");
    expect(inside).toContain("Screen frames");
    expect(inside).toContain("Encode FPS");
    expect(inside).toContain("Capture interval");
  });

  test("reports the interval per capture rather than as a raw sum", () => {
    const markup = renderToStaticMarkup(
      <StreamStatsBody
        stats={stats()}
        history={[stats()]}
        faults={[]}
        capture={{ ...capture, intervalMs: 16.5 }}
      />,
    );
    expect(row(markup, "Capture interval")).toBe("16.5 ms");
  });

  test("surfaces pump restarts, so a watchdog that fires is visible", () => {
    const markup = renderToStaticMarkup(
      <StreamStatsBody
        stats={stats()}
        history={[stats()]}
        faults={[]}
        sender={sender}
        capture={{ ...capture, pumpRestarts: 7 }}
      />,
    );
    expect(row(markup, "Pump restarts")).toBe("7");
    expect(help(markup, "Pump restarts")).toContain("WebRTC frame pump");
  });

  test("names the receiver cadence rows, which no other row reports", () => {
    const markup = renderToStaticMarkup(
      <StreamStatsBody
        stats={stats({ frameGapMs: 16.7, pacingDeviationMs: 1.62, decodeMsPerFrame: 0.44 })}
        history={[stats()]}
        faults={[]}
      />,
    );
    expect(row(markup, "Frame gap")).toBe("16.7 ms ± 1.6");
    expect(row(markup, "Decode")).toBe("0.4 ms");
  });

  test("shows the gap alone when its spread needed a second frame it did not get", () => {
    const markup = renderToStaticMarkup(
      <StreamStatsBody
        stats={stats({ frameGapMs: 16.7, pacingDeviationMs: null })}
        history={[stats()]}
        faults={[]}
      />,
    );
    expect(row(markup, "Frame gap")).toBe("16.7 ms");
  });

  test("keeps the scope out of the value, so a blank cell stays blank", () => {
    const markup = renderToStaticMarkup(
      <StreamStatsBody stats={stats()} history={[stats()]} faults={[]} capture={capture} />,
    );
    expect(row(markup, "Frame gap")).toBe("—");
    expect(row(markup, "Stalls")).toBe("0");
    expect(help(markup, "Stalls")).toContain("Since the session started");
    expect(markup).not.toContain("total<");
  });

  test("describes every labelled row, so a new metric cannot ship without its help text", () => {
    const markup = renderToStaticMarkup(
      <StreamStatsBody
        stats={stats()}
        history={[stats()]}
        faults={[]}
        sender={sender}
        capture={capture}
      />,
    );
    const labels = [...markup.matchAll(/data-stream-stat="([^"]+)"/g)].map(([, label]) => label ?? "");
    expect(labels).toContain("Capture interval");
    for (const label of labels) {
      // The tooltip opens with the label, so the meaning and the scope are what is left.
      const scope = scopeOf(markup, label);
      expect(scope).not.toBe("");
      const meaning = (help(markup, label) ?? "").slice(label.length, -scope.length).trim();
      expect(meaning.length).toBeGreaterThan(20);
    }
  });

  test("links a row to its description, so the help reaches a screen reader", () => {
    const markup = renderToStaticMarkup(
      <StreamStatsBody stats={stats()} history={[stats()]} faults={[]} capture={capture} />,
    );
    const described = markup.match(/aria-describedby="([^"]+)"/)?.[1];
    expect(described).toBeString();
    expect(markup).toContain(`id="${described}"`);
  });

  test("reads a long stall in seconds, where milliseconds stop being legible", () => {
    const markup = renderToStaticMarkup(
      <StreamStatsBody stats={stats()} history={[stats()]} faults={[]}
        capture={{ ...capture, stallSumMs: 2_936 }} />,
    );
    expect(row(markup, "Stall time")).toBe("2.9 s");
  });
});

describe("capture rows", () => {
  test("shows all four counts, so a stalled capture is distinguishable from a static screen", () => {
    const markup = renderToStaticMarkup(
      <StreamStatsBody stats={stats()} history={[stats()]} faults={[]} capture={capture} />,
    );
    expect(row(markup, "Screen frames")).toBe("60/s");
    expect(row(markup, "Idle frames")).toBe("0.0/s");
    expect(row(markup, "Capture deliveries")).toBe("60/s");
    expect(row(markup, "Pacer submissions")).toBe("60/s");
  });

  test("shows a fractional encoder rate, so a limping encoder is not a dead one", () => {
    const markup = renderToStaticMarkup(
      <StreamStatsBody
        stats={stats()}
        history={[stats()]}
        faults={[]}
        sender={{ ...sender, reportedFps: 0.4, sourceFps: 0.4 }}
      />,
    );
    expect(row(markup, "Encode FPS")).toBe("0.4 fps");
    expect(row(markup, "Pacer FPS")).toBe("0.4 fps");
  });

  test("separates a repeated frame from a captured one, which the frame rate cannot", () => {
    const markup = renderToStaticMarkup(
      <StreamStatsBody
        stats={stats()}
        history={[stats()]}
        faults={[]}
        capture={{ ...capture, screenFps: 0, deliveredFps: 4.7, submittedFps: 60 }}
      />,
    );
    expect(row(markup, "Screen frames")).toBe("0.0/s");
    expect(row(markup, "Capture deliveries")).toBe("4.7/s");
    expect(row(markup, "Pacer submissions")).toBe("60/s");
  });

  test("blanks a rate it has no window for rather than reading it as a stall", () => {
    const markup = renderToStaticMarkup(
      <StreamStatsBody
        stats={stats()}
        history={[stats()]}
        faults={[]}
        capture={{ ...capture, screenFps: null, deliveredFps: null, submittedFps: null }}
      />,
    );
    expect(row(markup, "Screen frames")).toBe("—");
    expect(row(markup, "Capture deliveries")).toBe("—");
    expect(row(markup, "Pacer submissions")).toBe("—");
  });
});

describe("statsToJson", () => {
  test("records the session context, so the file explains itself", () => {
    const parsed = JSON.parse(
      statsToJson([stats()], {
        transport: "webrtc", codec: "video/VP8", sender, capture: captureCounts,
      }),
    );
    expect(parsed.sender.encodeMsPerFrame).toBe(2.4);
    expect(parsed.capture.forwardedFrames).toBe(830);
    expect(parsed.transport).toBe("webrtc");
    expect(parsed.codec).toBe("video/VP8");
    expect(parsed.samples).toHaveLength(1);
    expect(typeof parsed.recordedAt).toBe("string");
  });
});
