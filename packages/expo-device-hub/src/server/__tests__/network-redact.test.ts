import { describe, expect, test } from "bun:test";

import { isSensitiveHeaderName as serveSimRule } from "../../../../serve-sim/packages/serve-sim/src/capture/redact";
import { isSensitiveHeaderName, redactHeaders } from "../network-redact";

const NAMES = [
  "Authorization",
  "Proxy-Authorization",
  "Cookie",
  "Set-Cookie",
  "set-cookie2",
  "X-CSRFToken",
  "x-apitoken",
  "X-Api-Key",
  "Idempotency-Key",
  "x-firebase-appcheck",
  "x-amz-content-sha256",
  "X-Session-Id",
  "Content-Type",
  "Accept",
  "Keep-Alive",
  ":authority",
  "User-Agent",
  "X-Request-Id",
];

describe("network-redact", () => {
  test("names the same credential headers as serve-sim's capture", () => {
    for (const name of NAMES)
      expect([name, isSensitiveHeaderName(name)]).toEqual([name, serveSimRule(name)]);
  });

  test("replaces credential values and keeps the rest", () => {
    expect(
      redactHeaders({
        Authorization: "Bearer abc",
        "Content-Type": "application/json",
        "Content-Length": 12,
      }),
    ).toEqual({
      Authorization: "[REDACTED]",
      "Content-Type": "application/json",
      "Content-Length": "12",
    });
  });
});
