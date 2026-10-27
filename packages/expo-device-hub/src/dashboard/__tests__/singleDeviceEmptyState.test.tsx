import { expect, test } from "bun:test";
import { EmptyState } from "@expo/hub-components";
import { renderToStaticMarkup } from "react-dom/server";

test("a pinned Simulator offers Start without device selection or creation", () => {
  const html = renderToStaticMarkup(
    <EmptyState platform="ios" singleDevice onStart={async () => ({ ok: true })} />,
  );
  expect(html).toContain("Start device");
  expect(html).toContain("Start the same device to continue.");
  expect(html).not.toContain("Use the + button");
});

test("a disconnected Android session keeps its reconnect instructions", () => {
  const html = renderToStaticMarkup(<EmptyState platform="android" singleDevice />);
  expect(html).toContain("Reconnect the same device to continue.");
  expect(html).not.toContain("Start device");
});

test("normal empty sessions retain their add-device instructions", () => {
  const html = renderToStaticMarkup(<EmptyState platform="ios" />);
  expect(html).toContain("Use the + button");
  expect(html).not.toContain("Start device");
});
