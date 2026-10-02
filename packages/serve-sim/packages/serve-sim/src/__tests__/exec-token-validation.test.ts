import { describe, expect, test } from "bun:test";

import { simMiddleware } from "../middleware";

describe("simMiddleware execToken", () => {
  // The exec channel compares a client's `token` frame with this value, so an
  // empty token accepts the empty frame any client can send.
  test("refuses an empty token, with or without the gate", () => {
    expect(() => simMiddleware({ basePath: "/", execToken: "" })).toThrow("execToken");
    expect(() => simMiddleware({ basePath: "/", execToken: "", requirePreviewToken: true })).toThrow("execToken");
  });

  // Under the gate a client sends the token as a bearer, a query, a cookie, or a subprotocol.
  test("refuses a token some clients could never send under the gate", () => {
    for (const token of ["a,b", " padded ", "with space", "a+b", "YWJjZA==", "semi;colon", "café", "end\n", "end\r", "end\r\n", "end\u2028"]) {
      expect(() => simMiddleware({ basePath: "/", execToken: token, requirePreviewToken: true })).toThrow("execToken");
    }
  });

  test("takes base64url, hex, and UUID tokens under the gate", () => {
    for (const token of ["jJ3k_Qx-9Zp2", "9f86d081884c7d65", "550e8400-e29b-41d4-a716-446655440000", "a.b~c"]) {
      expect(() => simMiddleware({ basePath: "/", execToken: token, requirePreviewToken: true })).not.toThrow();
    }
  });

  // Without the gate the exec client sends such a token in its first frame instead.
  test("keeps a token outside the subprotocol charset without the gate", () => {
    expect(() => simMiddleware({ basePath: "/", execToken: "YWJjZA==" })).not.toThrow();
  });
});
