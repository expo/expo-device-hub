import { describe, expect, test } from "bun:test";
import {
  ApiError,
  apiErrorResponse,
} from "../src/api/api-error.ts";
import { readBodyBytes, readJsonBody } from "../src/api/body.ts";
import {
  createApiRouter,
  type ApiErrorLogContext,
  type ApiLogger,
  type ApiRoute,
} from "../src/api/router.ts";

const url = (path: string) => `http://127.0.0.1:3011${path}`;

function streamBody(...chunks: Uint8Array[]): ReadableStream<Uint8Array> {
  return new ReadableStream({
    start(controller) {
      for (const chunk of chunks) controller.enqueue(chunk);
      controller.close();
    },
  });
}

async function errorJson(response: Response | null) {
  expect(response).toBeInstanceOf(Response);
  return (await response!.json()) as {
    ok: false;
    error: { code: string; message: string };
  };
}

describe("ApiError", () => {
  test.each([
    [400, "invalid_request"],
    [401, "unauthorized"],
    [403, "forbidden"],
    [404, "not_found"],
    [405, "method_not_allowed"],
    [409, "conflict"],
    [413, "payload_too_large"],
    [429, "rate_limited"],
    [500, "internal_error"],
    [502, "downstream_failure"],
    [503, "service_unavailable"],
  ] as const)("serializes status %i and code %s", async (status, code) => {
    const response = apiErrorResponse(
      new ApiError(status, code, "Safe message"),
    );

    expect(response.status).toBe(status);
    expect(response.headers.get("content-type")).toBe(
      "application/json; charset=utf-8",
    );
    expect(await response.json()).toEqual({
      ok: false,
      error: { code, message: "Safe message" },
    });
  });

  test("keeps causes out of the client response and preserves response headers", async () => {
    const response = apiErrorResponse(
      new ApiError(401, "unauthorized", "Authentication required", {
        cause: new Error("secret internal detail"),
        headers: { "WWW-Authenticate": "Bearer" },
      }),
    );
    const text = await response.text();

    expect(response.headers.get("www-authenticate")).toBe("Bearer");
    expect(text).not.toContain("secret internal detail");
  });

  test("rejects an incorrect status/code pairing", () => {
    expect(() => new ApiError(400, "not_found", "Missing")).toThrow(
      "API error code not_found must use status 404, not 400",
    );
  });
});

describe("bounded request bodies", () => {
  test("parses chunked JSON without trusting Content-Length", async () => {
    const encoder = new TextEncoder();
    const request = new Request(url("/api/example"), {
      method: "POST",
      body: streamBody(encoder.encode('{"ready":'), encoder.encode("true}")),
    });

    expect(await readJsonBody(request, 14)).toEqual({ ready: true });
  });

  test("rejects an oversized declared Content-Length before reading", async () => {
    const request = new Request(url("/api/example"), {
      method: "POST",
      headers: { "Content-Length": "900719925474099999999" },
      body: "{}",
    });

    await expect(readBodyBytes(request, 8)).rejects.toMatchObject({
      status: 413,
      code: "payload_too_large",
    });
    expect(request.bodyUsed).toBe(false);
  });

  test("counts actual UTF-8 bytes when no length is declared", async () => {
    const encoder = new TextEncoder();
    const request = new Request(url("/api/example"), {
      method: "POST",
      body: streamBody(encoder.encode('"🙂"')),
    });

    await expect(readJsonBody(request, 5)).rejects.toMatchObject({
      status: 413,
      code: "payload_too_large",
    });
  });

  test("maps malformed JSON and malformed UTF-8 to a safe validation error", async () => {
    const malformedJson = new Request(url("/api/example"), {
      method: "POST",
      body: "{",
    });
    const malformedUtf8 = new Request(url("/api/example"), {
      method: "POST",
      body: streamBody(new Uint8Array([0xc3, 0x28])),
    });

    await expect(readJsonBody(malformedJson)).rejects.toMatchObject({
      status: 400,
      code: "invalid_json",
      message: "Request body must be valid JSON",
    });
    await expect(readJsonBody(malformedUtf8)).rejects.toMatchObject({
      status: 400,
      code: "invalid_json",
      message: "Request body must be valid JSON",
    });
  });

  test("rejects an invalid Content-Length and invalid configured limits", async () => {
    const request = new Request(url("/api/example"), {
      method: "POST",
      headers: { "Content-Length": "-1" },
      body: "{}",
    });

    await expect(readBodyBytes(request, 10)).rejects.toMatchObject({
      status: 400,
      code: "invalid_request",
    });
    await expect(
      readBodyBytes(new Request(url("/api/example")), -1),
    ).rejects.toBeInstanceOf(RangeError);
  });
});

describe("createApiRouter", () => {
  type Deps = { value: string };
  const deps: Deps = { value: "injected" };

  test("matches exact paths and methods and passes request-scoped context", async () => {
    const routes: ApiRoute<Deps>[] = [
      {
        method: "GET",
        path: "/api/example",
        handler: ({ request, url: requestUrl, deps: requestDeps }) =>
          Response.json({
            method: request.method,
            query: requestUrl.searchParams.get("q"),
            value: requestDeps.value,
          }),
      },
    ];
    const router = createApiRouter(routes);

    const response = await router.handle(
      new Request(url("/api/example?q=search")),
      deps,
    );
    expect(await response!.json()).toEqual({
      method: "GET",
      query: "search",
      value: "injected",
    });
    expect(await router.handle(new Request(url("/apiary")), deps)).toBeNull();
    expect(await router.handle(new Request(url("/other")), deps)).toBeNull();
  });

  test("returns structured 404 only for claimed API paths", async () => {
    const router = createApiRouter<Deps>([]);
    const response = await router.handle(
      new Request(url("/api/missing")),
      deps,
    );

    expect(response!.status).toBe(404);
    expect(await errorJson(response)).toEqual({
      ok: false,
      error: { code: "not_found", message: "API route not found" },
    });
  });

  test("returns deterministic Allow for method mismatches", async () => {
    const handler = () => Response.json({ ok: true });
    const router = createApiRouter<Deps>([
      { method: "DELETE", path: "/api/example", handler },
      { method: "POST", path: "/api/example", handler },
      { method: "GET", path: "/api/example", handler },
    ]);
    const response = await router.handle(
      new Request(url("/api/example"), { method: "PATCH" }),
      deps,
    );

    expect(response!.status).toBe(405);
    expect(response!.headers.get("allow")).toBe("GET, POST, DELETE");
    expect(await errorJson(response)).toEqual({
      ok: false,
      error: {
        code: "method_not_allowed",
        message: "Method not allowed for this API route",
      },
    });
  });

  test("rejects duplicate method/path registrations", () => {
    const route: ApiRoute<Deps> = {
      method: "GET",
      path: "/api/example",
      handler: () => Response.json({ ok: true }),
    };

    expect(() => createApiRouter([route, route])).toThrow(
      "Duplicate API route: GET /api/example",
    );
  });

  test("preserves validation, conflict, and payload errors from handlers", async () => {
    const errors = [
      new ApiError(400, "invalid_request", "Invalid input"),
      new ApiError(409, "conflict", "Device is busy"),
      new ApiError(413, "payload_too_large", "Request body is too large"),
    ];

    for (const error of errors) {
      const router = createApiRouter<Deps>([
        {
          method: "POST",
          path: "/api/example",
          handler: () => {
            throw error;
          },
        },
      ]);
      const response = await router.handle(
        new Request(url("/api/example"), { method: "POST" }),
        deps,
      );

      expect(response!.status).toBe(error.status);
      expect(await errorJson(response)).toEqual({
        ok: false,
        error: { code: error.code, message: error.message },
      });
    }
  });

  test("logs downstream causes while returning only the safe message", async () => {
    const calls: Array<[string, ApiErrorLogContext]> = [];
    const logger: ApiLogger = {
      error(message, context) {
        calls.push([message, context]);
      },
    };
    const cause = new Error("adb output with private device details");
    const router = createApiRouter<Deps>(
      [
        {
          method: "GET",
          path: "/api/example",
          handler: () => {
            throw new ApiError(
              502,
              "downstream_failure",
              "Device command failed",
              { cause },
            );
          },
        },
      ],
      { logger },
    );
    const response = await router.handle(
      new Request(url("/api/example?token=do-not-log")),
      deps,
    );
    const text = await response!.text();

    expect(response!.status).toBe(502);
    expect(text).toContain("Device command failed");
    expect(text).not.toContain(cause.message);
    expect(calls).toEqual([
      [
        "API request failed",
        {
          method: "GET",
          path: "/api/example",
          status: 502,
          code: "downstream_failure",
          cause,
        },
      ],
    ]);
    expect(JSON.stringify(calls[0]?.[1])).not.toContain("do-not-log");
  });

  test("sanitizes unexpected 500s and survives a failing logger", async () => {
    const router = createApiRouter<Deps>(
      [
        {
          method: "GET",
          path: "/api/example",
          handler: () => {
            throw new Error("database password is hunter2");
          },
        },
      ],
      {
        logger: {
          error() {
            throw new Error("logger unavailable");
          },
        },
      },
    );
    const response = await router.handle(
      new Request(url("/api/example?token=super-secret")),
      deps,
    );
    const text = await response!.text();

    expect(response!.status).toBe(500);
    expect(JSON.parse(text)).toEqual({
      ok: false,
      error: { code: "internal_error", message: "Internal server error" },
    });
    expect(text).not.toContain("hunter2");
    expect(text).not.toContain("super-secret");
  });

  test("can widen the claimed path set for composition routes", async () => {
    const router = createApiRouter<Deps>(
      [
        {
          method: "GET",
          path: "/health",
          handler: () => Response.json({ ok: true }),
        },
      ],
      { isApiPath: (pathname) => pathname === "/health" },
    );

    const response = await router.handle(new Request(url("/health")), deps);
    expect(response!.status).toBe(200);
  });
});
