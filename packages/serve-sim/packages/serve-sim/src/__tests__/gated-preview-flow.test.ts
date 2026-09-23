import { afterAll, beforeAll, describe, expect, it } from "bun:test";

import { simMiddleware } from "../middleware";
import { servePreview, type PreviewServer } from "../runtime";

const PORT = 3473;
const TOKEN = "gated-flow-token";
const DEVICE = "404F2659-7202-4450-8465-912BD2AB744B";
const BASE = `http://127.0.0.1:${PORT}`;

let server: PreviewServer;

beforeAll(async () => {
  const middleware = simMiddleware({
    basePath: "/",
    execToken: TOKEN,
    device: DEVICE,
    requirePreviewToken: true,
  });
  server = await servePreview({ port: PORT, middleware, host: "127.0.0.1" });
});

afterAll(() => {
  server?.stop(true);
});

/** What a browser sends when it opens a link from another site. */
const NAVIGATION = {
  accept: "text/html",
  "sec-fetch-dest": "document",
  "sec-fetch-mode": "navigate",
  "sec-fetch-site": "cross-site",
};

function cookieFrom(response: Response): string {
  const header = response.headers.get("set-cookie") ?? "";
  return header.split(";")[0]!;
}

/**
 * The dashboard's link, driven the way a browser drives it.
 *
 * Every other test here calls the gate directly with headers it invents, which is how a real break
 * got through: the assertions checked that a Set-Cookie was issued, and nothing ever sent that
 * cookie back. This follows the redirect and reuses the cookie, so the whole exchange is covered.
 */
describe("opening a gated preview link", () => {
  it("trades the query token for a cookie and then serves the page", async () => {
    const redirect = await fetch(`${BASE}/?token=${TOKEN}`, {
      headers: NAVIGATION,
      redirect: "manual",
    });

    expect(redirect.status).toBe(302);
    // The token must not survive in the address bar.
    expect(redirect.headers.get("location")).toBe("/");
    const cookie = cookieFrom(redirect);
    expect(cookie).toContain("=");

    // The hop after the redirect is still reported as cross-site by the browser. The page body
    // itself needs a bundler-injected constant that does not exist when running from source, so
    // what matters here is that the gate let the request through to the preview handler at all.
    const page = await fetch(`${BASE}/`, { headers: { ...NAVIGATION, cookie } });
    expect(page.status).not.toBe(401);
    expect(await page.text()).not.toContain("token");
  });

  it("refuses the same cookie on a subresource request from another origin", async () => {
    const redirect = await fetch(`${BASE}/?token=${TOKEN}`, {
      headers: NAVIGATION,
      redirect: "manual",
    });
    const cookie = cookieFrom(redirect);

    // A cross-origin page can read this response, so the cookie alone must not be enough.
    const api = await fetch(`${BASE}/api`, {
      headers: {
        cookie,
        "sec-fetch-dest": "empty",
        "sec-fetch-mode": "cors",
        "sec-fetch-site": "same-site",
      },
    });
    expect(api.status).toBe(401);
  });

  it("serves the page on a same-origin request with the cookie", async () => {
    const redirect = await fetch(`${BASE}/?token=${TOKEN}`, {
      headers: NAVIGATION,
      redirect: "manual",
    });
    const cookie = cookieFrom(redirect);

    const api = await fetch(`${BASE}/api`, {
      headers: { cookie, origin: BASE, "sec-fetch-site": "same-origin" },
    });
    expect(api.status).toBe(200);
  });

  it("refuses a page load with no token at all", async () => {
    const page = await fetch(`${BASE}/`, { headers: NAVIGATION, redirect: "manual" });
    expect(page.status).toBe(401);
  });

  it("refuses a cookie that carries the wrong token", async () => {
    const redirect = await fetch(`${BASE}/?token=${TOKEN}`, {
      headers: NAVIGATION,
      redirect: "manual",
    });
    const name = cookieFrom(redirect).split("=")[0]!;

    const page = await fetch(`${BASE}/`, {
      headers: { ...NAVIGATION, cookie: `${name}=not-the-token` },
    });
    expect(page.status).toBe(401);
  });
});
