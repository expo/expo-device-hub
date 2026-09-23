import { describe, expect, test } from "bun:test";

import { TOKEN_FORM_SCRIPT, unauthorizedPreviewPage } from "../unauthorized-page";

describe("unauthorizedPreviewPage", () => {
  test("asks for a token and offers a labelled field to paste one", () => {
    const html = unauthorizedPreviewPage();

    expect(html).toContain("<title>Simulator Preview</title>");
    expect(html).toContain("This session is protected");
    expect(html).toContain("only opens with a token");
    expect(html).toContain(">Submit</button>");
    expect(html).toContain(">Security token</label>");
    expect(html.match(/Security token/g)).toEqual(["Security token"]);
    expect(html).toContain('name="token"');
    expect(html).toContain('for="token"');
    expect(html).toContain('<meta name="robots" content="noindex">');
    expect(html).not.toContain("isn't valid");
    expect(html).not.toContain('role="alert"');
  });

  test("reports a rejected token and keeps the field", () => {
    const html = unauthorizedPreviewPage({ rejectedToken: true });

    expect(html).toContain("<title>Simulator Preview</title>");
    expect(html).toContain("only opens with a token");
    expect(html).toContain("This token isn't valid.");
    expect(html).toContain(">Security token</label>");
    expect(html.match(/Security token/g)).toEqual(["Security token"]);
    expect(html).toContain(">Submit</button>");
    expect(html).toContain('aria-invalid="true"');
    expect(html).toContain('role="alert"');
    expect(html).toContain('name="token"');
    expect(html).not.toContain("doesn't match");
  });

  test("shows no example link carrying a token", () => {
    expect(unauthorizedPreviewPage()).not.toContain("?token=");
    expect(unauthorizedPreviewPage({ rejectedToken: true })).not.toContain("?token=");
  });
});

describe("token form script", () => {
  function load(href: string) {
    const assigned: string[] = [];
    const handlers: Array<(event: { preventDefault: () => void }) => void> = [];
    let reportedValidity = false;
    const input = {
      value: "",
      reportValidity: () => {
        reportedValidity = true;
      },
    };
    const form = {
      token: input,
      addEventListener: (_: string, handler: (event: { preventDefault: () => void }) => void) => {
        handlers.push(handler);
      },
    };
    const document = { forms: [form] };
    const window = { location: { href, assign: (to: string) => assigned.push(to) } };
    new Function("document", "window", TOKEN_FORM_SCRIPT)(document, window);

    return {
      assigned,
      input,
      get reportedValidity() {
        return reportedValidity;
      },
      submit(value: string) {
        input.value = value;
        for (const handler of handlers) handler({ preventDefault: () => {} });
      },
    };
  }

  test("adds the token to the current address and keeps the rest of the query", () => {
    const page = load("http://host:3477/preview?device=ABC");
    page.submit("  tok-1  ");

    expect(page.assigned).toEqual(["http://host:3477/preview?device=ABC&token=tok-1"]);
  });

  test("replaces a token already in the address", () => {
    const page = load("http://host:3477/?token=stale");
    page.submit("tok-1");

    expect(page.assigned).toEqual(["http://host:3477/?token=tok-1"]);
  });

  test("keeps a leading-double-slash path on this origin, so the token cannot be sent elsewhere", () => {
    const page = load("http://host:3477//evil.example/x");
    page.submit("tok-1");

    expect(page.assigned).toEqual(["http://host:3477//evil.example/x?token=tok-1"]);
  });

  test("asks the browser to explain a blank field instead of navigating", () => {
    const page = load("http://host:3477/preview?device=ABC");
    page.submit("   ");

    expect(page.assigned).toEqual([]);
    expect(page.reportedValidity).toBe(true);
    expect(page.input.value).toBe("");
  });
});
