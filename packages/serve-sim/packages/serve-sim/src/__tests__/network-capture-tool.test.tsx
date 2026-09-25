import { describe, expect, test } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";

import { BodySection, requestKey } from "../client/components/network-capture-requests";

import {
  CaptureState,
  CaptureStatusTooltip,
  DomainSection,
  OversizedBodiesNotice,
  RequestFacts,
  RequestRow,
  TimingBar,
  captureStatusLabel,
  captureControl,
  formatMs,
  groupByDomain,
} from "../client/components/network-capture-tool";
import { CAPTURE_SCHEMA_VERSION, type CaptureMeta, type CapturedRequest } from "../capture/store";

function request(overrides: Partial<CapturedRequest> = {}): CapturedRequest {
  return {
    id: "r1",
    method: "GET",
    url: "https://speed.cloudflare.com/__down?bytes=10000000",
    status: 200,
    mimeType: "application/octet-stream",
    requestBytes: 0,
    responseBytes: 9_500_000,
    startedAt: 0,
    ttfbMs: 31,
    durationMs: 171,
    failure: null,
    ...overrides,
  };
}

const UDID = "ABCD1234-0000-0000-0000-0000000000EF";

const row = (overrides: Partial<CapturedRequest> = {}, slowestMs = 171) =>
  renderToStaticMarkup(
    <RequestRow request={request(overrides)} udid={UDID} slowestMs={slowestMs} />,
  );

describe("RequestRow", () => {
  test("fits status, path, payload, method, host, and duration without wrapping", () => {
    const html = row();

    expect(html).toContain("200");
    expect(html).toContain("/__down?bytes=10000000");
    expect(html).toContain("GET");
    expect(html).toContain("speed.cloudflare.com");
    expect(html).toContain("9.1 MB");
    expect(html).toContain("171ms");
    expect(html).not.toContain("wait 31ms");
    expect(html).not.toContain("transfer");
  });

  test("reports the payload from whichever direction carried it", () => {
    const html = row({ method: "POST", requestBytes: 1_900_000, responseBytes: 0 });

    expect(html).toContain("1.8 MB");
    expect(html).toContain("POST");
  });

  test("marks a failed request in the row, with the reason kept for the detail", () => {
    const html = row({
      status: null,
      failure: "The app rejected our certificate, which means it pins its own.",
      ttfbMs: null,
      durationMs: 2100,
    });

    expect(html).toContain("err");
    expect(html).toContain("2.1s");
  });

  test("keeps an in-flight request readable before it settles", () => {
    const html = row({ status: null, ttfbMs: null, durationMs: null, responseBytes: 0 });

    expect(html).toContain("···");
    expect(html).not.toContain("NaN");
    expect(html).not.toContain("undefined");
  });
});

describe("requestKey", () => {
  test("gives a new session's reused id a new row", () => {
    expect(requestKey(request({ id: "r1", startedAt: 1 }))).not.toBe(requestKey(request({ id: "r1", startedAt: 2 })));
    expect(requestKey(request({ id: "r1", startedAt: 1 }))).toBe(requestKey(request({ id: "r1", startedAt: 1 })));
  });
});

describe("list separators", () => {
  test("drops the last row's rule, which would otherwise double up with the footer", () => {
    expect(row()).toContain("last:border-b-0");
  });

  test("puts a group's rule on the group, so an expanded one closes after its rows", () => {
    const html = renderToStaticMarkup(
      <DomainSection
        group={{ host: "a.test", requests: [request()], bytes: 100, failed: 0 }}
        udid={UDID}
        slowestMs={171}
      />,
    );

    expect(html).toContain("border-b border-white/5 last:border-b-0");
    expect(html).not.toContain("text-left border-b");
  });
});

describe("TimingBar", () => {
  test("scales the wait and transfer segments against the slowest request on screen", () => {
    const html = renderToStaticMarkup(
      <TimingBar request={request({ ttfbMs: 100, durationMs: 200 })} slowestMs={400} />,
    );

    // 100ms of 400ms waiting, then 100ms transferring.
    expect(html).toContain("width:25%");
  });

  test("never exceeds the track, even when a request outlasts the window's slowest", () => {
    const html = renderToStaticMarkup(
      <TimingBar request={request({ ttfbMs: 900, durationMs: 900 })} slowestMs={100} />,
    );

    const widths = [...html.matchAll(/width:(\d+(?:\.\d+)?)%/g)].map((match) => Number(match[1]));
    expect(Math.max(...widths)).toBeLessThanOrEqual(100);
  });

  test("draws a failure as one bar rather than a split it does not have", () => {
    const html = renderToStaticMarkup(
      <TimingBar request={request({ failure: "connection refused", durationMs: 50 })} slowestMs={100} />,
    );

    expect(html).toContain("bg-red-400/50");
    expect(html).not.toContain("bg-sky-400/60");
  });
});

describe("groupByDomain", () => {
  test("collects requests per host, summing bytes and counting failures", () => {
    const groups = groupByDomain([
      request({ id: "r1", url: "https://a.test/one", responseBytes: 100 }),
      request({ id: "r2", url: "https://b.test/two", responseBytes: 50, requestBytes: 10 }),
      request({ id: "r3", url: "https://a.test/three", responseBytes: 400, status: 502 }),
    ]);

    expect(groups.map((group) => group.host)).toEqual(["a.test", "b.test"]);
    const [a, b] = groups;
    if (a === undefined || b === undefined) throw new Error("expected two domain groups");
    expect(a.requests).toHaveLength(2);
    expect(a.bytes).toBe(500);
    expect(a.failed).toBe(1);
    expect(b.bytes).toBe(60);
    expect(b.failed).toBe(0);
  });

  test("counts a transport failure as failed even without a status", () => {
    const groups = groupByDomain([
      request({ url: "https://a.test/x", status: null, failure: "connection refused" }),
    ]);

    const [group] = groups;
    if (group === undefined) throw new Error("expected one domain group");
    expect(group.failed).toBe(1);
  });

  test("keeps an unparseable url visible under a named group", () => {
    const groups = groupByDomain([request({ url: "not-a-url" })]);

    const [group] = groups;
    if (group === undefined) throw new Error("expected one domain group");
    expect(group.host).toBe("unknown");
  });
});

describe("DomainSection", () => {
  test("shows the roll-up and stays collapsed so a busy host does not bury the rest", () => {
    const html = renderToStaticMarkup(
      <DomainSection
        group={{ host: "speed.cloudflare.com", requests: [request()], bytes: 48_000_000, failed: 0 }}
        udid={UDID}
        slowestMs={171}
      />,
    );

    expect(html).toContain("speed.cloudflare.com");
    expect(html).toContain("45.8 MB");
    expect(html).toContain("req");
    expect(html).toContain('aria-expanded="false"');
    expect(html).not.toContain("/__down?bytes=10000000");
  });

  test("surfaces failures on a collapsed host, instead of hiding them until expanded", () => {
    const html = renderToStaticMarkup(
      <DomainSection
        group={{ host: "api.example.com", requests: [request()], bytes: 0, failed: 3 }}
        udid={UDID}
        slowestMs={171}
      />,
    );

    expect(html).toContain("3 failed");
  });
});

describe("CaptureState", () => {
  test("omits a redundant off message when there is no error", () => {
    expect(renderToStaticMarkup(<CaptureState attachment="not-enabled" attachError={null} />)).toBe("");
  });

  test("keeps an off-state reason visible", () => {
    const html = renderToStaticMarkup(
      <CaptureState attachment="not-enabled" attachError="Capture is unavailable." />,
    );

    expect(html).toContain("Capture is unavailable.");
  });

  test("keeps the reason visible when capture failed, rather than showing a spinner", () => {
    const html = renderToStaticMarkup(
      <CaptureState attachment="failed" attachError="mitmproxy is not installed" />,
    );

    expect(html).toContain("mitmproxy is not installed");
  });

  test("says it is starting while capture is enabled", () => {
    const html = renderToStaticMarkup(
      <CaptureState attachment="starting" attachError={null} />,
    );

    expect(html).toContain("Starting capture");
  });

  test("says nothing at all while capture is healthy", () => {
    const html = renderToStaticMarkup(
      <CaptureState attachment="capturing" attachError={null} />,
    );

    expect(html).toBe("");
  });
});

describe("CaptureStatusTooltip", () => {
  test("notes when response bodies are off while capturing", () => {
    const html = renderToStaticMarkup(
      <CaptureStatusTooltip
        capturing
        starting={false}
        fields={["header", "request-body"]}
      />,
    );
    expect(html).toContain("Capture enabled");
    expect(html).toContain("Response bodies not captured");
  });

  test("stays single-line when response bodies are allowlisted", () => {
    const html = renderToStaticMarkup(
      <CaptureStatusTooltip
        capturing
        starting={false}
        fields={["header", "request-body", "response-body"]}
      />,
    );
    expect(html).toBe("Capture enabled");
  });
});

describe("captureStatusLabel", () => {
  test("folds the response-body note into the accessible label", () => {
    expect(captureStatusLabel(true, false, ["header", "request-body"])).toBe(
      "Capture enabled. Response bodies not captured.",
    );
  });
});

describe("OversizedBodiesNotice", () => {
  test("stays quiet when nothing was dropped", () => {
    expect(renderToStaticMarkup(<OversizedBodiesNotice count={0} />)).toBe("");
  });

  test("names the drop count and the env override when posts were rejected", () => {
    const html = renderToStaticMarkup(<OversizedBodiesNotice count={2} />);
    expect(html).toContain("Dropped 2 oversized capture posts");
    expect(html).toContain("SERVE_SIM_CAPTURE_MAX_CONTROL_BODY_BYTES");
    expect(html).toContain("[capture] Dropped oversized control body");
  });
});

describe("RequestFacts", () => {
  test("names each figure, so nothing has to be inferred from a glyph", () => {
    const html = renderToStaticMarkup(<RequestFacts request={request({ requestBytes: 412 })} />);

    expect(html).toContain("Method");
    expect(html).toContain("Received");
    expect(html).toContain("Sent");
    expect(html).toContain("Waiting");
    expect(html).toContain("Total");
    expect(html).toContain("412 B");
  });

  test("leaves out figures a request does not have, rather than showing zeroes", () => {
    const html = renderToStaticMarkup(
      <RequestFacts
        request={request({ requestBytes: 0, responseBytes: 0, mimeType: null, ttfbMs: null })}
      />,
    );

    expect(html).not.toContain("Sent");
    expect(html).not.toContain("Received");
    expect(html).not.toContain("Type");
    expect(html).not.toContain("Waiting");
  });
});

describe("formatMs", () => {
  test("switches to seconds once milliseconds stop reading well", () => {
    expect(formatMs(90)).toBe("90ms");
    expect(formatMs(999)).toBe("999ms");
    expect(formatMs(1000)).toBe("1.0s");
    expect(formatMs(2140)).toBe("2.1s");
  });
});

describe("captureControl", () => {
  const meta = (attachment: CaptureMeta["attachment"]): CaptureMeta => ({
    schemaVersion: CAPTURE_SCHEMA_VERSION,
    udid: UDID,
    attachment,
    attachError: null,
    proxyAddress: null,
    droppedOversizedBodies: 0,
    fields: [],
  });

  test("waits for the first frame before offering capture", () => {
    expect(captureControl({ meta: null, errored: false, changing: false })).toEqual({
      disabled: true,
      label: "Enable capture",
    });
  });

  test("stays clickable when the stream failed", () => {
    expect(captureControl({ meta: null, errored: true, changing: false })).toEqual({
      disabled: false,
      label: "Reboot with capture",
    });
  });

  test("holds still while capture changes", () => {
    expect(captureControl({ meta: meta("capturing"), errored: false, changing: true })).toEqual({
      disabled: true,
      label: "Working…",
    });
    expect(captureControl({ meta: meta("starting"), errored: false, changing: false })).toEqual({
      disabled: true,
      label: "Starting…",
    });
  });

  test("offers the opposite of the device's current state", () => {
    expect(captureControl({ meta: meta("capturing"), errored: false, changing: false })).toEqual({
      disabled: false,
      label: "Turn off (reboots)",
    });
    expect(captureControl({ meta: meta("not-enabled"), errored: false, changing: false })).toEqual({
      disabled: false,
      label: "Enable capture",
    });
    expect(captureControl({ meta: meta("failed"), errored: false, changing: false })).toEqual({
      disabled: false,
      label: "Reboot with capture",
    });
  });
});

test("body previews report UTF-8 bytes instead of UTF-16 length", () => {
  const html = renderToStaticMarkup(
    <BodySection label="Response body" text="é🙂" binary={false} truncated={false} />,
  );
  expect(html).toContain("6 B");
  expect(html).not.toContain("3 B");
});
