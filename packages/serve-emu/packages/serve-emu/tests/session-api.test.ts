import { describe, expect, test } from "bun:test";
import {
  DEFAULT_SESSION_PAGE_LIMIT,
  MAX_SESSION_PAGE_LIMIT,
  parseSessionPageQuery,
} from "../src/session-api.ts";

function query(value: string): URLSearchParams {
  return new URLSearchParams(value);
}

describe("parseSessionPageQuery", () => {
  test("uses a bounded default and accepts an exclusive cursor", () => {
    expect(parseSessionPageQuery(query(""))).toEqual({
      limit: DEFAULT_SESSION_PAGE_LIMIT,
    });
    expect(parseSessionPageQuery(query("limit=6&before=42"))).toEqual({
      limit: 6,
      before: 42,
    });
    expect(
      parseSessionPageQuery(query(`limit=${MAX_SESSION_PAGE_LIMIT}`)),
    ).toEqual({ limit: MAX_SESSION_PAGE_LIMIT });
  });

  test("rejects invalid, unsafe, and oversized parameters", () => {
    for (const value of ["0", "-1", "1.5", "six", ""]) {
      expect(() => parseSessionPageQuery(query(`limit=${value}`))).toThrow();
    }
    expect(() =>
      parseSessionPageQuery(query(`limit=${MAX_SESSION_PAGE_LIMIT + 1}`)),
    ).toThrow("limit must be at most");
    expect(() =>
      parseSessionPageQuery(query("before=9007199254740992")),
    ).toThrow("before must be a positive safe integer");
    for (const value of ["0", "-1", "1.5", "cursor", ""]) {
      expect(() =>
        parseSessionPageQuery(query(`before=${value}`)),
      ).toThrow();
    }
  });
});
