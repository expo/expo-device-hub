import { expect, test } from "bun:test";
import { EmptyState } from "@expo/hub-components";
import { renderToStaticMarkup } from "react-dom/server";

test("a missing session device asks for the same device, without lifecycle or add controls", () => {
  for (const platform of ["ios", "android"] as const) {
    const html = renderToStaticMarkup(<EmptyState platform={platform} singleDevice />);
    expect(html).toContain("Reconnect the same device to continue.");
    expect(html).not.toContain("Start device");
    expect(html).not.toContain("Use the + button");
  }
});

test("normal empty sessions retain their add-device instructions", () => {
  const html = renderToStaticMarkup(<EmptyState platform="ios" />);
  expect(html).toContain("Use the + button");
});
