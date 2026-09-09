import { describe, expect, test } from "bun:test";
import { randomId } from "../client/utils/random-id";

const UUID_V4 = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

describe("randomId", () => {
  test("returns a v4 uuid", () => {
    expect(randomId()).toMatch(UUID_V4);
  });

  test("falls back to getRandomValues where randomUUID is missing", () => {
    // `randomUUID` lives on the prototype, so shadow it on the instance.
    Object.defineProperty(crypto, "randomUUID", { value: undefined, configurable: true });
    try {
      expect(typeof crypto.randomUUID).not.toBe("function");
      const ids = new Set(Array.from({ length: 100 }, () => randomId()));
      for (const id of ids) expect(id).toMatch(UUID_V4);
      expect(ids.size).toBe(100);
    } finally {
      Reflect.deleteProperty(crypto, "randomUUID");
    }
  });
});
