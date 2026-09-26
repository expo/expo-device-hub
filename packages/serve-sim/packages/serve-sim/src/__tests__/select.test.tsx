import { describe, expect, test } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";
import { Select, filterSelectOptions } from "../client/components/select";

const options = [
  { value: "host", label: "Host default" },
  { value: "America/Los_Angeles", label: "America/Los Angeles (GMT-7)" },
  { value: "Asia/Tokyo", label: "Asia/Tokyo (GMT+9)" },
];

const values = (query: string) => filterSelectOptions(options, query).map((o) => o.value);

describe("filterSelectOptions", () => {
  test("returns the same array for an empty or blank query", () => {
    expect(filterSelectOptions(options, "")).toBe(options);
    expect(filterSelectOptions(options, "   ")).toBe(options);
  });

  test("matches label or value, ignoring case", () => {
    expect(values("tokyo")).toEqual(["Asia/Tokyo"]);
    expect(values("HOST")).toEqual(["host"]);
    expect(values("GMT+9")).toEqual(["Asia/Tokyo"]);
  });

  test("treats underscores and spaces as the same separator", () => {
    expect(values("los angeles")).toEqual(["America/Los_Angeles"]);
    expect(values("los_angeles")).toEqual(["America/Los_Angeles"]);
  });

  test("returns nothing when no option matches", () => {
    expect(values("zzzz")).toEqual([]);
  });
});

describe("Select", () => {
  const render = (props: Partial<Parameters<typeof Select>[0]> = {}) =>
    renderToStaticMarkup(
      <Select label="Time Zone" value="Asia/Tokyo" options={options} onChange={() => {}} {...props} />,
    );

  test("shows the selected option on the closed trigger", () => {
    const html = render();
    expect(html).toContain('aria-label="Time Zone"');
    expect(html).toContain('aria-expanded="false"');
    expect(html).toContain("Asia/Tokyo (GMT+9)");
  });

  test("falls back to the raw value when it is not among the options", () => {
    expect(render({ value: "Asia/Calcutta" })).toContain("Asia/Calcutta");
  });

  test("renders disabled when asked", () => {
    expect(render({ disabled: true })).toMatch(/<button[^>]* disabled=""/);
    expect(render()).not.toMatch(/<button[^>]* disabled=""/);
  });
});
