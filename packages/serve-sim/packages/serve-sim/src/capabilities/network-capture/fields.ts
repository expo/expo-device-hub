import type { CapturedBody } from "./store";

export const CAPTURE_FIELDS = ["header", "query", "request-body", "response-body"] as const;

export type CaptureField = (typeof CAPTURE_FIELDS)[number];

export const DEFAULT_CAPTURE_FIELDS: readonly CaptureField[] = [];

const CAPTURE_FIELD_SET = new Set<string>(CAPTURE_FIELDS);

export function isCaptureField(value: string): value is CaptureField {
  return CAPTURE_FIELD_SET.has(value);
}

export function parseCaptureFields(values: readonly string[]): CaptureField[] {
  const seen = new Set<CaptureField>();
  for (const part of values.flatMap((value) => value.split(","))) {
    const value = part.trim().toLowerCase();
    if (!value) continue;
    if (!isCaptureField(value)) {
      throw new Error(
        `Unknown network capture field '${part.trim()}'. Supported: ${CAPTURE_FIELDS.join(", ")}.`,
      );
    }
    seen.add(value);
  }
  return [...seen];
}

export function resolveCaptureFields(values: readonly string[] | undefined): CaptureField[] {
  if (!values || values.length === 0) return [...DEFAULT_CAPTURE_FIELDS];
  return parseCaptureFields(values);
}

export function captureFieldSet(fields: readonly CaptureField[]): ReadonlySet<CaptureField> {
  return new Set(fields);
}

export function applyCaptureFields(
  body: CapturedBody,
  fields: ReadonlySet<CaptureField>,
): CapturedBody {
  const headers = fields.has("header");
  const requestBody = fields.has("request-body");
  const responseBody = fields.has("response-body");
  return {
    requestHeaders: headers ? body.requestHeaders : {},
    responseHeaders: headers ? body.responseHeaders : {},
    requestBody: requestBody ? body.requestBody : null,
    responseBody: responseBody ? body.responseBody : null,
    requestTruncated: requestBody && body.requestTruncated,
    responseTruncated: responseBody && body.responseTruncated,
    requestBinary: requestBody && body.requestBinary,
    responseBinary: responseBody && body.responseBinary,
  };
}
