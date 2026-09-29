import { describe, expect, test } from "bun:test";

import {
  DEFAULT_CAPTURE_FIELDS,
  applyCaptureFields,
  captureFieldSet,
  parseCaptureFields,
  resolveCaptureFields,
} from "../fields";
import type { CapturedBody } from "../store";

const fullBody: CapturedBody = {
  requestHeaders: { Accept: "application/json", Authorization: "x" },
  responseHeaders: { "Content-Type": "text/plain" },
  requestBody: '{"a":1}',
  responseBody: "hello",
  requestTruncated: true,
  responseTruncated: true,
  requestBinary: false,
  responseBinary: true,
};

describe("parseCaptureFields", () => {
  test("accepts repeated and comma-separated values", () => {
    expect(parseCaptureFields(["header", "request-body,response-body"])).toEqual([
      "header",
      "request-body",
      "response-body",
    ]);
  });

  test("dedupes and normalizes case", () => {
    expect(parseCaptureFields(["Header", "header", "REQUEST-BODY"])).toEqual([
      "header",
      "request-body",
    ]);
  });

  test("rejects unknown fields", () => {
    expect(() => parseCaptureFields(["cookie"])).toThrow(/Unknown network capture field/);
  });
});

describe("resolveCaptureFields", () => {
  test("defaults to nothing beyond metadata", () => {
    expect(resolveCaptureFields(undefined)).toEqual([]);
    expect(resolveCaptureFields([])).toEqual([]);
  });

  test("uses an explicit allowlist when provided", () => {
    expect(resolveCaptureFields(["response-body"])).toEqual(["response-body"]);
    expect(resolveCaptureFields(["header", "request-body", "response-body"])).toEqual([
      "header",
      "request-body",
      "response-body",
    ]);
  });
});

describe("applyCaptureFields", () => {
  test("default fields keep nothing but metadata", () => {
    // Bodies are opt-in: they carry credentials and nothing redacts them.
    expect(applyCaptureFields(fullBody, captureFieldSet(DEFAULT_CAPTURE_FIELDS))).toEqual({
      requestHeaders: {},
      responseHeaders: {},
      requestBody: null,
      responseBody: null,
      requestTruncated: false,
      responseTruncated: false,
      requestBinary: false,
      responseBinary: false,
    });
  });

  test("can keep only headers", () => {
    expect(applyCaptureFields(fullBody, captureFieldSet(["header"]))).toEqual({
      requestHeaders: fullBody.requestHeaders,
      responseHeaders: fullBody.responseHeaders,
      requestBody: null,
      responseBody: null,
      requestTruncated: false,
      responseTruncated: false,
      requestBinary: false,
      responseBinary: false,
    });
  });

  test("can keep all fields", () => {
    expect(
      applyCaptureFields(
        fullBody,
        captureFieldSet(["header", "request-body", "response-body"]),
      ),
    ).toEqual(fullBody);
  });
});
