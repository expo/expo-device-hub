import { afterEach, describe, expect, test } from "bun:test";
import { Window } from "happy-dom";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { renderToStaticMarkup } from "react-dom/server";

import {
  CPU_RENDERING_STATUS_LABEL,
  CPU_RENDERING_TEXT,
  CPU_RENDERING_TITLE,
  DeviceTitle,
} from "../dashboard/DeviceTitle";
import { border, icon, text } from "../theme/tokens";
import { createGlobalStubs } from "./test-globals";

const DEVICE = { id: "emulator-5554", name: "Medium Phone" };
const RENDERER_NAMES = /swiftshader|lavapipe|llvmpipe/i;
/** The 12-unit chevron after "Live", which marks the status as something that opens details. */
const CHEVRON = /<svg[^>]*viewBox="0 0 12 12"[^>]*><path d="M3 4.5 6 7.5l3-3"/;

function markup(props: Partial<Parameters<typeof DeviceTitle>[0]> = {}) {
  return renderToStaticMarkup(
    <DeviceTitle device={DEVICE} status="streaming" renderingOnCpu {...props} />,
  );
}

describe("the status pill of an emulator that renders on the CPU", () => {
  test("keeps the Live label in the warning colors, with a chevron besides the color", () => {
    const html = markup();
    expect(html).toContain(">Live</span>");
    expect(html).toContain(`background-color:${icon.warning}`);
    expect(html).toContain(`border:2px solid ${border.warning}`);
    expect(html).toContain(`color:${text.warning}">Live</span>`);
    expect(html).not.toContain(text.success);
    // A sharp 12 px chevron follows the label, pointing down while the details are closed.
    expect(html).toMatch(/>Live<\/span><svg width="12" height="12" viewBox="0 0 12 12"/);
    expect(html).toMatch(CHEVRON);
    const chevron = html.slice(html.indexOf('viewBox="0 0 12 12"'));
    expect(chevron).toMatch(/^[^>]*aria-hidden="true"/);
    expect(chevron).toMatch(/^[^>]*transform:rotate\(0deg\)/);
    expect(chevron).toContain(
      `stroke="${icon.warning}" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"`,
    );
    expect(html).not.toMatch(RENDERER_NAMES);
  });

  test("splits the name and the status into two buttons that do not nest", () => {
    const html = markup();
    const buttons = html.match(/<button[^>]*>/g) ?? [];
    expect(buttons).toHaveLength(2);
    expect(html.indexOf("</button>")).toBeLessThan(html.lastIndexOf("<button"));
    // The name button keeps the name; the status button opens the details.
    expect(buttons[0]).not.toContain("aria-haspopup");
    expect(html.slice(0, html.indexOf("</button>"))).toContain(`title="${DEVICE.name}"`);
    expect(buttons[1]).toContain('aria-haspopup="dialog"');
    expect(buttons[1]).toContain('aria-expanded="false"');
    expect(buttons[1]).toContain(`aria-label="${CPU_RENDERING_STATUS_LABEL}"`);
    expect(buttons[1]).toContain('type="button"');
  });

  test("keeps a recording label outside both buttons", () => {
    const html = markup({ recording: "recording" });
    expect(html.lastIndexOf("</button>")).toBeLessThan(html.indexOf('role="status"'));
  });

  test.each(["idle", "connecting", "reconnecting", "error"] as const)(
    "shows no warning while the stream is %s",
    (status) => {
      const html = markup({ status });
      expect(html.match(/<button/g)).toHaveLength(1);
      expect(html).not.toContain("aria-haspopup");
      expect(html).not.toContain(text.warning);
      expect(html).not.toMatch(CHEVRON);
    },
  );

  test("shows the plain green Live pill for an emulator that renders on the GPU", () => {
    const html = markup({ renderingOnCpu: false });
    expect(html.match(/<button/g)).toHaveLength(1);
    expect(html).not.toContain("aria-haspopup");
    expect(html).toContain(`color:${text.success}">Live</span>`);
    expect(html).not.toMatch(CHEVRON);
  });
});

const { stubGlobal, restoreGlobals } = createGlobalStubs();
let root: Root | undefined;
let dom: Window | undefined;

afterEach(async () => {
  if (root) await act(async () => root?.unmount());
  await dom?.happyDOM.close();
  root = undefined;
  dom = undefined;
  restoreGlobals();
});

async function renderPill({ reducedMotion = false } = {}) {
  dom = new Window();
  const prefersReducedMotion = (query: string) => ({
    matches: reducedMotion && query === "(prefers-reduced-motion: reduce)",
    addEventListener: () => {},
    removeEventListener: () => {},
  });
  (dom as unknown as { matchMedia: typeof prefersReducedMotion }).matchMedia = prefersReducedMotion;
  stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  stubGlobal("window", dom);
  stubGlobal("document", dom.document);
  for (const name of [
    "navigator",
    "Node",
    "Element",
    "HTMLElement",
    "HTMLInputElement",
    "Event",
    "CustomEvent",
    "KeyboardEvent",
    "PointerEvent",
    "FocusEvent",
    "MutationObserver",
    "NodeFilter",
    "MouseEvent",
    "getComputedStyle",
    "requestAnimationFrame",
    "cancelAnimationFrame",
  ] as const) {
    stubGlobal(name, (dom as unknown as Record<string, unknown>)[name]);
  }
  const container = dom.document.createElement("div");
  const outside = dom.document.createElement("p");
  dom.document.body.append(container, outside);
  root = createRoot(container as unknown as HTMLDivElement);
  await act(async () =>
    root!.render(<DeviceTitle device={DEVICE} status="streaming" renderingOnCpu />),
  );
  const status = container.querySelector("button[aria-haspopup]") as unknown as HTMLButtonElement;
  const name = container.querySelector("button:not([aria-haspopup])") as unknown as HTMLElement;
  const dialog = () =>
    dom!.document.querySelector('[role="dialog"]') as unknown as HTMLElement | null;
  const chevron = () => status.querySelector("svg") as unknown as SVGElement;
  return { dom, container, outside, status, name, dialog, chevron };
}

describe("the CPU rendering popover", () => {
  test("turns the chevron up while the details are open, and down again when they close", async () => {
    const { dom, status, dialog, chevron } = await renderPill();
    expect(chevron().style.transform).toBe("rotate(0deg)");
    expect(chevron().style.transition).toContain("transform");

    await act(async () => status.click());
    expect(dialog()).not.toBeNull();
    expect(chevron().style.transform).toBe("rotate(180deg)");

    await act(async () => {
      dom.document.activeElement!.dispatchEvent(
        new dom.KeyboardEvent("keydown", { key: "Escape", bubbles: true, cancelable: true }),
      );
    });
    expect(chevron().style.transform).toBe("rotate(0deg)");
  });

  test("turns the chevron without a transition when the user prefers reduced motion", async () => {
    const { status, chevron } = await renderPill({ reducedMotion: true });
    await act(async () => status.click());
    expect(chevron().style.transform).toBe("rotate(180deg)");
    expect(chevron().style.transition).toBe("");
  });

  test("opens from the status button as a non-modal dialog with the exact text", async () => {
    const { status, dialog } = await renderPill();
    expect(dialog()).toBeNull();
    // A native button: Enter and Space send this click in a browser.
    expect(status.tagName).toBe("BUTTON");
    await act(async () => status.click());

    const opened = dialog()!;
    expect(opened).not.toBeNull();
    expect(status.getAttribute("aria-expanded")).toBe("true");
    expect(status.getAttribute("aria-controls")).toBe(opened.id);
    expect(opened.getAttribute("aria-modal")).toBeNull();
    const title = dom!.document.getElementById(opened.getAttribute("aria-labelledby")!);
    const description = dom!.document.getElementById(opened.getAttribute("aria-describedby")!);
    expect(title?.textContent).toBe(CPU_RENDERING_TITLE);
    expect(description?.textContent).toBe(CPU_RENDERING_TEXT);
    expect(opened.textContent).toBe(CPU_RENDERING_TITLE + CPU_RENDERING_TEXT);
    expect(opened.textContent).not.toMatch(RENDERER_NAMES);
  });

  test("closes on Escape and returns the focus to the status button", async () => {
    const { dom, status, dialog } = await renderPill();
    status.focus();
    await act(async () => status.click());
    expect(dialog()).not.toBeNull();
    // The non-modal dialog takes the focus, so Escape reaches it.
    expect(dialog()!.contains(dom.document.activeElement as unknown as Node)).toBe(true);

    await act(async () => {
      dom.document.activeElement!.dispatchEvent(
        new dom.KeyboardEvent("keydown", { key: "Escape", bubbles: true, cancelable: true }),
      );
    });
    // Radix returns the focus in the next task after the content unmounts.
    await act(async () => new Promise((resolve) => setTimeout(resolve, 0)));
    expect(dialog()).toBeNull();
    expect(status.getAttribute("aria-expanded")).toBe("false");
    expect(dom.document.activeElement).toBe(status as unknown as typeof dom.document.activeElement);
  });

  test("closes on a click outside", async () => {
    const { dom, outside, status, dialog } = await renderPill();
    await act(async () => status.click());
    expect(dialog()).not.toBeNull();

    // Radix listens for a pointer outside from the next task after it opens.
    await act(async () => new Promise((resolve) => setTimeout(resolve, 0)));
    await act(async () => {
      outside.dispatchEvent(new dom.PointerEvent("pointerdown", { bubbles: true }));
      outside.dispatchEvent(new dom.MouseEvent("click", { bubbles: true }));
    });
    expect(dialog()).toBeNull();
  });

  test("leaves the name button to toggle the name and the ID", async () => {
    const { container, name, dialog } = await renderPill();
    await act(async () => name.click());
    expect(dialog()).toBeNull();
    expect(container.textContent).toContain(DEVICE.id);
  });
});
