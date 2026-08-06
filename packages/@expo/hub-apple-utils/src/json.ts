/** Small JSON helpers shared by the `simctl` output parsers. */

import { type AppleUtilsResult, reportError, result } from "./errors";

/** `JSON.parse` that returns `undefined` plus an `error` instead of throwing. */
export function safeJsonParse(json: string): AppleUtilsResult<unknown | undefined> {
  try {
    return result(JSON.parse(json));
  } catch (error) {
    return result(undefined, reportError("[apple-utils] Failed to parse JSON output:", error));
  }
}

/** Narrow an unknown value to a plain (non-array) object. */
export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** Return `value` when it is a string, otherwise `undefined`. */
export function asString(value: unknown): string | undefined {
  return typeof value === "string" ? value : undefined;
}
