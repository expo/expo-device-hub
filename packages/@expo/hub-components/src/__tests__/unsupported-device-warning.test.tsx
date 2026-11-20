import { afterEach, beforeEach, expect, test } from "bun:test";
import { Window } from "happy-dom";
import userEvent from "@testing-library/user-event";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";

import { DeviceListItem } from "../components/DeviceListItem";
import { createGlobalStubs } from "./test-globals";

const { stubGlobal, restoreGlobals } = createGlobalStubs();
let browser: Window;
let container: HTMLDivElement;
let root: Root;
let selections: number;
let user: ReturnType<typeof userEvent.setup>;

beforeEach(async () => {
  browser = new Window();
  stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  stubGlobal("window", browser);
  stubGlobal("document", browser.document);
  for (const key of [
    "HTMLElement",
    "HTMLInputElement",
    "Node",
    "NodeFilter",
    "MutationObserver",
    "CustomEvent",
    "ResizeObserver",
    "Element",
    "SVGElement",
    "HTMLButtonElement",
  ] as const)
    stubGlobal(key, browser[key]);
  stubGlobal("getComputedStyle", browser.getComputedStyle.bind(browser));
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
  selections = 0;
  user = userEvent.setup({ document });
  // Happy DOM has no layout. Supply a visible viewport/anchor for Popper's
  // detach check; browser validation covers actual clipping and collisions.
  Object.defineProperties(document.documentElement, {
    clientWidth: { value: 1024, configurable: true },
    clientHeight: { value: 768, configurable: true },
  });
  await act(async () =>
    root.render(
      <DeviceListItem
        name="Pixel Tablet"
        version="Android 16"
        platform="android"
        unsupported
        onClick={() => selections++}
      />,
    ),
  );
  const anchor = trigger();
  const rect = new browser.DOMRect(45, 164, 28, 28);
  anchor.getBoundingClientRect = () => rect;
  Object.defineProperty(anchor, "getClientRects", { value: () => [rect] });
});

afterEach(async () => {
  await act(async () => root.unmount());
  // Radix restores focus in a timer when its focus scope unmounts.
  await new Promise((resolve) => setTimeout(resolve, 0));
  await browser.happyDOM.close();
  restoreGlobals();
});

function trigger() {
  return container.querySelector<HTMLButtonElement>('button[aria-haspopup="dialog"]')!;
}
function row() {
  return container.querySelector<HTMLButtonElement>("button[aria-pressed]")!;
}
function dialog() {
  return document.querySelector<HTMLElement>('[role="dialog"]');
}

test("uses separate buttons, preserving ordinary selection and a named warning trigger", async () => {
  expect(container.querySelector("button button")).toBeNull();
  expect(trigger().type).toBe("button");
  expect(trigger().getAttribute("aria-label")).toContain(
    "Unsupported or untested device: Pixel Tablet",
  );
  expect(trigger().getAttribute("aria-expanded")).toBe("false");
  expect(dialog()).toBeNull();
  await act(async () => user.click(row()));
  expect(selections).toBe(1);
  expect(dialog()).toBeNull();
});

for (const key of ["{Enter}", " "]) {
  test(`${key} opens details without selecting; Escape dismisses and restores focus`, async () => {
    await act(async () => user.tab());
    expect(document.activeElement === row()).toBe(true);
    await act(async () => user.tab());
    expect(document.activeElement === trigger()).toBe(true);
    await act(async () => user.keyboard(key));
    const details = dialog()!;
    expect(details).not.toBeNull();
    expect(trigger().getAttribute("aria-expanded")).toBe("true");
    expect(trigger().getAttribute("aria-controls")).toBe(details.id);
    expect(details.querySelector("h2")?.textContent).toBe("Unsupported or untested device");
    // The popup must escape the sidebar's clipping container and keep its accessible labels.
    expect(container.contains(details)).toBe(false);
    expect(document.getElementById(details.getAttribute("aria-labelledby")!)?.textContent).toBe(
      "Unsupported or untested device",
    );
    expect(
      document.getElementById(details.getAttribute("aria-describedby")!)?.textContent,
    ).toContain("screen streaming and device controls may not work as expected");
    expect(details.textContent).toContain(
      "screen streaming and device controls may not work as expected",
    );
    expect(details.textContent).not.toMatch(/GPU|CPU|FPS/);
    expect(document.body.style.overflow).not.toBe("hidden");
    expect(selections).toBe(0);
    await act(async () => user.keyboard("{Escape}"));
    await act(async () => new Promise((resolve) => setTimeout(resolve, 0)));
    expect(dialog()).toBeNull();
    expect(trigger().getAttribute("aria-expanded")).toBe("false");
    expect(document.activeElement === trigger()).toBe(true);
    expect(selections).toBe(0);
  });
}

test("touch opens details, tapping their text does not select, and the trigger toggles closed", async () => {
  await act(async () => user.pointer([{ keys: "[TouchA]", target: trigger() }]));
  expect(dialog()).not.toBeNull();
  await act(async () =>
    user.pointer([{ keys: "[TouchA]", target: dialog()!.querySelector("p")! }]),
  );
  expect(dialog()).not.toBeNull();
  expect(selections).toBe(0);
  await act(async () => user.pointer([{ keys: "[TouchA]", target: trigger() }]));
  expect(dialog()).toBeNull();
  expect(selections).toBe(0);
});

test("outside interaction dismisses without stealing focus; another row remains selectable", async () => {
  const outside = document.createElement("button");
  outside.textContent = "Outside";
  document.body.append(outside);
  await act(async () => user.click(trigger()));
  expect(dialog()).not.toBeNull();
  await act(async () => {
    await user.click(outside);
    await new Promise((resolve) => setTimeout(resolve, 0));
  });
  expect(dialog()).toBeNull();
  expect(document.activeElement === outside).toBe(true);
  expect(selections).toBe(0);
  await act(async () => user.click(trigger()));
  await act(async () => user.click(row()));
  expect(dialog()).toBeNull();
  expect(selections).toBe(1);
});

test("supported devices retain a single selection button without a warning", async () => {
  await act(async () =>
    root.render(<DeviceListItem name="Pixel 9" version="Android 16" platform="android" selected />),
  );
  expect(trigger()).toBeNull();
  expect(container.querySelectorAll("button")).toHaveLength(1);
  expect(row().getAttribute("aria-pressed")).toBe("true");
});

test("a device that cannot stream names the reason in its trigger and details", async () => {
  await act(async () =>
    root.render(
      <DeviceListItem
        name="iPhone"
        version="iOS 26.4"
        platform="ios"
        unsupported
        unsupportedReason="needs iOS 27"
      />,
    ),
  );
  expect(trigger().getAttribute("aria-label")).toBe(
    "Cannot stream iPhone: needs iOS 27. Show details",
  );
  await act(async () => user.click(trigger()));
  const details = dialog()!;
  expect(details.querySelector("h2")?.textContent).toBe("Cannot stream this device");
  expect(details.querySelector("p")?.textContent).toBe(
    "This device needs iOS 27 to stream in Expo Device Hub.",
  );
});
