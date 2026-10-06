import {
  EMPTY_CLIENT,
  testFeature,
  testError,
} from "../../../hub-client/src/__tests__/feature-fixture";
import { describe, expect, test } from "bun:test";
import { type DeviceClient } from "@expo/hub-client";
import { renderToStaticMarkup } from "react-dom/server";

import { LocationSection } from "../dashboard/LocationSection";

const BASE_CLIENT: DeviceClient = {
  ...EMPTY_CLIENT,
  platform: "android",
  location: { ...EMPTY_CLIENT.location, ...testFeature(null) },
};

/** `false` hides location; `clear` marks a backend that can also remove the fix. */
type LocationSupport = false | { clear?: true };

function locationClient(
  overrides: Partial<DeviceClient> = {},
  location: LocationSupport = {},
): DeviceClient {
  return {
    ...BASE_CLIENT,
    ...overrides,
    location:
      location === false
        ? { ...EMPTY_CLIENT.location }
        : { ...(overrides.location ?? BASE_CLIENT.location), canClear: !!location.clear },
  };
}

function render(client: DeviceClient) {
  return renderToStaticMarkup(<LocationSection client={client} defaultOpen />);
}

function inputTag(html: string, label: string) {
  const labelIndex = html.indexOf(`aria-label="${label}"`);
  expect(labelIndex).toBeGreaterThanOrEqual(0);

  const start = html.lastIndexOf("<input", labelIndex);
  return html.slice(start, html.indexOf(">", labelIndex) + 1);
}

function buttonTag(html: string, label: string) {
  const labelIndex = html.indexOf(`>${label}</span>`);
  expect(labelIndex).toBeGreaterThanOrEqual(0);

  const start = html.lastIndexOf("<button", labelIndex);
  return html.slice(start, html.indexOf(">", start) + 1);
}

describe("LocationSection", () => {
  test("renders nothing for a backend that offers no location control", () => {
    expect(renderToStaticMarkup(<LocationSection client={locationClient({}, false)} />)).toBe("");
  });

  test("seeds both boxes from the confirmed fix and names it in the closing note", () => {
    const html = render(
      locationClient({
        location: {
          ...BASE_CLIENT.location,
          ...testFeature({ latitude: 37.3349, longitude: -122.009 }),
        },
      }),
    );

    expect(inputTag(html, "Latitude")).toContain('value="37.3349"');
    expect(inputTag(html, "Longitude")).toContain('value="-122.009"');
    expect(html).toContain("Last set: 37.3349, -122.0090");
    expect(html).not.toContain("No fix set in this session.");
  });

  test("says no fix is known before the first confirmed write", () => {
    const html = render(locationClient());

    expect(inputTag(html, "Latitude")).toContain('value=""');
    expect(html).toContain("No fix set in this session.");
  });

  test("shows the preset whose coordinates the boxes hold", () => {
    const selected = (client: DeviceClient) =>
      render(client).replace(/ data-test-options="[^"]*"/g, "");

    expect(
      selected(
        locationClient({
          location: {
            ...BASE_CLIENT.location,
            ...testFeature({ latitude: 37.3349, longitude: -122.009 }),
          },
        }),
      ),
    ).toContain(">Apple Park</span>");
    expect(
      selected(
        locationClient({
          location: { ...BASE_CLIENT.location, ...testFeature({ latitude: 1, longitude: 2 }) },
        }),
      ),
    ).toContain(">Custom</span>");
    expect(
      selected(
        locationClient({
          location: { ...BASE_CLIENT.location, ...testFeature({ latitude: 1, longitude: 2 }) },
        }),
      ),
    ).not.toContain(">Apple Park</span>");
  });

  test("offers Clear only to a backend that can remove a fix", () => {
    expect(render(locationClient())).not.toContain(">Clear</span>");
    expect(render(locationClient({}, { clear: true }))).toContain(">Clear</span>");
  });

  test("disables every control and posts a status note while a write is in flight", () => {
    const html = render(
      locationClient(
        {
          location: {
            ...BASE_CLIENT.location,
            writes: {
              ...BASE_CLIENT.location.writes,
              pending: new Set(["fix" as const]),
            },
          },
        },
        { clear: true },
      ),
    );

    expect(html).toContain("Updating location…");
    expect(inputTag(html, "Latitude")).toContain('disabled=""');
    expect(inputTag(html, "Longitude")).toContain('disabled=""');
    expect(buttonTag(html, "Set location")).toContain('disabled=""');
    expect(buttonTag(html, "Clear")).toContain('disabled=""');
  });

  test("reports a refused write as an alert", () => {
    const html = render(
      locationClient({
        location: {
          ...BASE_CLIENT.location,
          writes: {
            pending: new Set(),
            errors: new Map([["fix", testError("latitude out of range")]]),
          },
        },
      }),
    );

    const alert = html.match(/<span role="alert"[^>]*>([^<]*)<\/span>/);
    expect(alert?.[1]).toBe("latitude out of range");
  });

  test("lists Custom first, then every preset", () => {
    const html = render(locationClient());
    const options = html.match(/data-test-options="([^"]*)"/);

    expect(options?.[1].split("\n")).toEqual([
      "Custom",
      "Apple Park",
      "Googleplex",
      "London",
      "Tokyo",
      "Sydney",
    ]);
  });
});
