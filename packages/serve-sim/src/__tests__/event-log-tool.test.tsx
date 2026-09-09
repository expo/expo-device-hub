import { describe, expect, test } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";
import { EventLogTool } from "../client/components/event-log-tool";

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
