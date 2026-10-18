import { describe, expect, test } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";
import { EventLogTool } from "../client/components/event-log-tool";
import { runChildSuite } from "./fixtures/run-child-suite";

describe("EventLogTool", () => {
  test("keeps the count and chevron in the three-column summary row", () => {
    const html = renderToStaticMarkup(
      <EventLogTool udid="DEVICE" eventsEndpoint="/events" />,
    );
    const summary = html.match(/<summary[^>]*>(.*?)<\/summary>/)?.[1] ?? "";

    expect(summary).not.toContain("<span></span>");
    expect(summary).toContain("justify-self-end");
  });
});

test("event log subscriptions follow the visible section and selected device", async () => {
  const { exitCode, output } = await runChildSuite("event-log-tool.child.tsx");
  expect(output).toContain("5 pass");
  expect(exitCode).toBe(0);
}, 10_000);
