import { describe, expect, test } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";

import {
  formatDuration,
  formatSize,
  JsonBody,
  NetworkSection,
  RequestDetails,
  splitUrl,
  statusLook,
} from "../dashboard/NetworkSection";
import { text } from "../theme/tokens";

describe("NetworkSection", () => {
  test("renders collapsed under the Network title", () => {
    const html = renderToStaticMarkup(
      <NetworkSection
        status={{ state: "searching" }}
        requests={[]}
        responseBodies={{}}
        onClear={() => {}}
        onRequestResponseBody={() => {}}
      />,
    );
    expect(html).toContain("Network");
    expect(html).not.toContain("Network requests");
  });

  test("colors a status by its class, and failures as errors", () => {
    expect(statusLook({ status: 204 })).toEqual({ label: "204", color: text.success });
    expect(statusLook({ status: 304 })).toEqual({ label: "304", color: text.info });
    expect(statusLook({ status: 404 })).toEqual({ label: "404", color: text.warning });
    expect(statusLook({ status: 502 })).toEqual({ label: "502", color: text.danger });
    expect(statusLook({ failed: "Canceled" })).toEqual({ label: "ERR", color: text.danger });
    expect(statusLook({})).toEqual({ label: "…", color: text.tertiary });
  });

  test("formats time and size", () => {
    expect(formatDuration({ startedAt: 0 })).toBe("pending");
    expect(formatDuration({ startedAt: 1_000, finishedAt: 1_042 })).toBe("42 ms");
    expect(formatDuration({ startedAt: 0, finishedAt: 2_500 })).toBe("2.50 s");
    expect(formatSize(undefined)).toBe("—");
    expect(formatSize(512)).toBe("512 B");
    expect(formatSize(2_048)).toBe("2.0 kB");
    expect(formatSize(3 * 1024 * 1024)).toBe("3.0 MB");
  });

  test("splits a URL into path and host", () => {
    expect(splitUrl("https://api.example.com/v1/items?page=2")).toEqual({
      path: "/v1/items?page=2",
      host: "api.example.com",
    });
    expect(splitUrl("not a url")).toEqual({ path: "not a url", host: "" });
  });

  test("offers to try a body again after it failed", () => {
    const html = renderToStaticMarkup(
      <RequestDetails
        request={{ id: "1.r1", method: "GET", url: "https://x/", startedAt: 0, finishedAt: 5 }}
        responseBody={{ state: "error", message: "The Hub did not answer. Try again." }}
        onRequestResponseBody={() => {}}
        onClose={() => {}}
      />,
    );
    expect(html).toContain("The Hub did not answer.");
    expect(html).toContain(">Try again</button>");
  });

  test("opens only the bodies, and counts headers in a closed block", () => {
    const html = renderToStaticMarkup(
      <RequestDetails
        request={{
          id: "1.r1",
          method: "POST",
          url: "https://x/",
          startedAt: 0,
          requestHeaders: { Accept: "*/*", Authorization: "[REDACTED]" },
          requestBody: "{}",
        }}
        responseBody={undefined}
        onRequestResponseBody={() => {}}
        onClose={() => {}}
      />,
    );
    expect(html.match(/<button[^>]*aria-expanded="true"/g)).toHaveLength(2);
    expect(html.match(/<button[^>]*aria-expanded="false"/g)).toHaveLength(3);
    expect(html).toContain(">2</span>");
    expect(html).not.toContain("[REDACTED]");
    expect(html).toContain("The body loads when the response completes.");
  });

  test("shows a JSON body as a tree whose objects and arrays fold", () => {
    const html = renderToStaticMarkup(
      <JsonBody body='{"ok":true,"data":{"items":[1,"two",null]},"empty":{}}' />,
    );
    expect(html).toContain('role="tree"');
    expect(html).toContain('aria-label="Collapse data"');
    expect(html).toContain('aria-label="Collapse items"');
    expect(html.match(/<button/g)).toHaveLength(3);
    expect(html).toContain("&quot;two&quot;");
  });

  test("opens only the first levels of a large JSON body", () => {
    const deep = JSON.stringify({ a: { b: { c: { d: 1 } } }, pad: "x".repeat(25_000) });
    const html = renderToStaticMarkup(<JsonBody body={deep} />);
    expect(html).toContain('aria-label="Collapse a"');
    expect(html).toContain('aria-label="Expand b"');
    expect(html).toContain("1 key");
  });

  test("shows a body that is not JSON as text", () => {
    const html = renderToStaticMarkup(<JsonBody body='{"cut": "short' />);
    expect(html).not.toContain('role="tree"');
    expect(html).toContain("<pre");
  });
});
