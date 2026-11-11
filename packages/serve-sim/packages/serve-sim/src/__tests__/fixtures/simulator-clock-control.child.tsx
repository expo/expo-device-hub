import { afterEach, expect, mock, spyOn, test } from "bun:test";
import { act, create, type ReactTestRenderer } from "react-test-renderer";
import * as realControl from "../../socket/client-control";
import { Select } from "../../client/components/select";

const status: { clock: string; "time-zone": string; "host-time-zone"?: string } = {
  clock: "2030-01-01T09:00:00+09:00",
  "time-zone": "Asia/Tokyo",
  "host-time-zone": "Asia/Tokyo",
};
const initialStatus = { ...status };
const calls: Array<{ device: string; option?: string; value?: string }> = [];
let setError: string | null = null;
let readError: string | null = null;
let emptyStatus = false;
let nextRead: Promise<typeof status | null> | null = null;
let blockedSet: Promise<void> | null = null;
mock.module("../../socket/client-control", () => ({
  ...realControl,
  hostUiRequest: async (request: { device: string; option?: string; value?: string }) => {
    calls.push(request);
    if (request.option && setError) throw new Error(setError);
    if (request.option) {
      if (blockedSet) await blockedSet;
      return undefined;
    }
    if (nextRead) {
      const read = nextRead;
      nextRead = null;
      return await read;
    }
    if (readError) throw new Error(readError);
    return emptyStatus ? null : { ...status };
  },
}));
const { ClockControl, SimulatorSettingsTool } =
  await import("../../client/components/simulator-settings-tool");

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
let renderer: ReactTestRenderer | undefined;
let elapsed = 0;
let tick = () => {};
let pickerValue = "";
const input = { value: "", showPicker: () => (pickerValue = input.value), focus: () => {} };
const changes: string[] = [];
const intervals = new Map<unknown, { delay: number; callback: () => void }>();

async function mountPanel() {
  const originalSet = globalThis.setInterval;
  const originalClear = globalThis.clearInterval;
  spyOn(globalThis, "setInterval").mockImplementation(((callback: () => void, delay: number) => {
    const timer = originalSet(callback, 1_000_000_000);
    intervals.set(timer, { delay, callback });
    return timer;
  }) as typeof setInterval);
  spyOn(globalThis, "clearInterval").mockImplementation(((
    timer: ReturnType<typeof setInterval>,
  ) => {
    intervals.delete(timer);
    originalClear(timer);
  }) as typeof clearInterval);
  await act(async () => {
    renderer = create(<SimulatorSettingsTool udid="test-device" runtime="iOS-26-5" />, {
      createNodeMock: (node) => (node.type === "input" ? input : null),
    });
  });
}
const polls = () => [...intervals.values()].filter((timer) => timer.delay === 30_000);
async function poll() {
  expect(polls()).toHaveLength(1);
  await act(async () => polls()[0]!.callback());
}

async function mount(value = status.clock, zone = status["time-zone"]) {
  elapsed = 0;
  spyOn(performance, "now").mockImplementation(() => elapsed);
  const original = globalThis.setInterval;
  spyOn(globalThis, "setInterval").mockImplementation(((callback: () => void) => {
    tick = callback;
    return original(callback, 1_000_000_000);
  }) as typeof setInterval);
  await act(async () => {
    renderer = create(
      <ClockControl
        value={value}
        zone={zone}
        disabled={false}
        onChange={(value) => changes.push(value)}
      />,
      { createNodeMock: (node) => (node.type === "input" ? input : null) },
    );
  });
}
const field = () => renderer!.root.findByProps({ type: "datetime-local" });
const button = () => renderer!.root.findByProps({ "aria-label": "Date & Time" });
async function advance(ms: number) {
  elapsed = ms;
  await act(async () => tick());
}
async function change(value: string) {
  await act(async () => field().props.onChange({ target: { value } }));
}
async function settle() {
  await act(async () => Bun.sleep(650));
}
afterEach(async () => {
  if (renderer) await act(async () => renderer?.unmount());
  renderer = undefined;
  mock.restore();
  calls.length = 0;
  changes.length = 0;
  setError = null;
  readError = null;
  emptyStatus = false;
  nextRead = null;
  blockedSet = null;
  Object.assign(status, initialStatus);
  intervals.clear();
  input.value = "";
  pickerValue = "";
  tick = () => {};
});

test("the label ticks and reopening starts at the current simulator time", async () => {
  await mount();
  await advance(3_600_000);
  expect(button().props.children).toBe("2030-01-01 10:00");
  await act(async () => button().props.onClick());
  expect(pickerValue).toBe("2030-01-01T10:00");
  // Refresh at open too: background tabs can throttle interval callbacks.
  elapsed += 3_600_000;
  await act(async () => button().props.onClick());
  expect(pickerValue).toBe("2030-01-01T11:00");
});

test("clock ticks respect a daylight saving transition", async () => {
  await mount("2030-03-10T01:59:00-05:00", "America/New_York");
  await advance(60_000);
  expect(button().props.children).toBe("2030-03-10 03:00");
});

test("historical UTC fallback edits keep their UTC meaning", async () => {
  await mount("1971-01-01T00:00:01Z", "Africa/Monrovia");
  await act(async () => button().props.onClick());
  await change("1971-01-01T00:01");
  await settle();
  expect(changes).toEqual(["1971-01-01T00:01Z"]);
});

test("a clock tick does not replace fields while the picker is open", async () => {
  await mount();
  await act(async () => button().props.onClick());
  input.value = "2035-06-01T09:30";
  await advance(120_000);
  expect(input.value).toBe("2035-06-01T09:30");
});

test("a browser without the simulator zone ticks with an explicit UTC label", async () => {
  await mount(status.clock, "unavailable/browser-zone");
  await advance(60_000);
  expect(button().props.children).toBe("2030-01-01 00:01 UTC");
});

test("reset cancels an unsettled pick", async () => {
  await mount();
  await change("2035-06-01T09:30");
  await act(async () =>
    renderer!.root.findByProps({ "aria-label": "Back to the host time" }).props.onClick(),
  );
  await settle();
  expect(changes).toEqual(["host"]);
});

test("unmount cancels an unsettled pick", async () => {
  await mount();
  await change("2035-06-01T09:30");
  await act(async () => renderer!.unmount());
  renderer = undefined;
  await settle();
  expect(changes).toEqual([]);
});

test("switching devices cancels a picker edit queued for the previous device", async () => {
  await mount();
  await change("2035-06-01T09:30");
  await act(async () => {
    renderer!.update(
      <ClockControl
        key="second-device"
        value="host"
        zone="UTC"
        disabled={false}
        onChange={(value) => changes.push(value)}
      />,
    );
  });
  await settle();
  expect(changes).toEqual([]);
  expect(button().props.children).toBe("Host default");
});

test("a successful set reads back a canonical clock instead of freezing the optimistic pick", async () => {
  await act(async () => {
    renderer = create(<SimulatorSettingsTool udid="test-device" runtime="iOS-26-5" />);
  });
  await act(async () => renderer!.root.findByType(ClockControl).props.onChange("2030-01-01T09:00"));
  expect(calls.filter((call) => !call.option)).toHaveLength(2);
  expect(renderer!.root.findByType(ClockControl).props.value).toBe(status.clock);
});

test("a refused pick keeps its error visible while reading back the current clock", async () => {
  await act(async () => {
    renderer = create(<SimulatorSettingsTool udid="test-device" runtime="iOS-26-5" />);
  });
  setError = "This local time does not exist: daylight saving time skips it.";
  await act(async () => renderer!.root.findByType(ClockControl).props.onChange("2030-03-10T02:30"));
  const messages = renderer!.root.findAllByType("span").map((node) => node.props.children);
  expect(messages).toContain(setError);
  expect(renderer!.root.findByType(ClockControl).props.value).toBe(status.clock);
});

for (const failure of ["rejected", "empty"] as const) {
  test(`a successful set with ${failure} readback marks the clock unavailable until Retry succeeds`, async () => {
    await act(async () => {
      renderer = create(<SimulatorSettingsTool udid="test-device" runtime="iOS-26-5" />);
    });
    if (failure === "rejected") readError = "Clock status connection closed";
    else emptyStatus = true;
    const expectedError = readError ?? "Unexpected simulator-settings reply";
    await act(async () =>
      renderer!.root.findByType(ClockControl).props.onChange("2035-06-01T09:30"),
    );
    expect(calls.some((call) => call.option === "clock" && call.value === "2035-06-01T09:30")).toBe(
      true,
    );
    const messages = () => renderer!.root.findAllByType("span").map((node) => node.props.children);
    expect(messages()).toContain(expectedError);
    expect(button().props.children).toBe("Unavailable");
    expect(button().props.disabled).toBe(true);
    readError = null;
    emptyStatus = false;
    const retry = renderer!.root
      .findAllByType("button")
      .find((node) => node.props.children === "Retry")!;
    await act(async () => retry.props.onClick());
    expect(renderer!.root.findByType(ClockControl).props.value).toBe(status.clock);
    expect(button().props.children).toBe("2030-01-01 09:00");
    expect(button().props.disabled).toBe(false);
    expect(messages()).not.toContain(expectedError);
    expect(
      renderer!.root.findAllByType("button").some((node) => node.props.children === "Retry"),
    ).toBe(false);
  });
}

test("host-zone metadata keeps the clock ticking through DST and polls canonical changes", async () => {
  Object.assign(status, {
    clock: "2030-03-10T01:59:50-05:00",
    "time-zone": "host",
    "host-time-zone": "America/New_York",
  });
  elapsed = 0;
  spyOn(performance, "now").mockImplementation(() => elapsed);
  await mountPanel();
  expect(button().props.children).toBe("2030-03-10 01:59");
  expect(renderer!.root.findByType(ClockControl).props.zone).toBe("America/New_York");
  elapsed = 30_000;
  await act(async () => [...intervals.values()].find((timer) => timer.delay === 1000)!.callback());
  expect(button().props.children).toBe("2030-03-10 03:00");
  status.clock = "2030-03-10T03:00:20-04:00";
  await poll();
  expect(renderer!.root.findByType(ClockControl).props.value).toBe(status.clock);
  expect(button().props.children).toBe("2030-03-10 03:00");
});

for (const zone of ["host", "unavailable/browser-zone"]) {
  test(`an unknown zone ${zone} displays UTC and submits UTC instead of guessing an offset`, async () => {
    await mount("2030-03-10T01:59:50-05:00", zone);
    await advance(30_000);
    expect(button().props.children).toBe("2030-03-10 07:00 UTC");
    await act(async () => button().props.onClick());
    expect(pickerValue).toBe("2030-03-10T07:00");
    await change("2030-07-01T09:00");
    await settle();
    expect(changes).toEqual(["2030-07-01T09:00Z"]);
  });
}

test("host metadata resolves the clock zone while host selection and cross-season edits stay local", async () => {
  Object.assign(status, {
    clock: "2030-01-01T09:00:00-05:00",
    "time-zone": "host",
    "host-time-zone": "America/New_York",
  });
  await mountPanel();
  expect(renderer!.root.findByType(ClockControl).props.zone).toBe("America/New_York");
  const zoneSelect = renderer!.root
    .findAllByType(Select)
    .find((node) => node.props.label === "Time Zone")!;
  expect(zoneSelect.props.value).toBe("host");
  await act(async () => button().props.onClick());
  expect(pickerValue).toBe("2030-01-01T09:00");
  await change("2030-07-01T09:00");
  await settle();
  expect(calls.find((call) => call.option === "clock")?.value).toBe("2030-07-01T09:00");
});

test("an older host without zone metadata displays and edits explicitly in UTC", async () => {
  Object.assign(status, { clock: "2030-01-01T09:00:00-05:00", "time-zone": "host" });
  delete status["host-time-zone"];
  await mountPanel();
  expect(button().props.children).toBe("2030-01-01 14:00 UTC");
  await act(async () => button().props.onClick());
  expect(pickerValue).toBe("2030-01-01T14:00");
  await change("2030-07-01T09:00");
  await settle();
  expect(calls.find((call) => call.option === "clock")?.value).toBe("2030-07-01T09:00Z");
});

test("edits in a known simulator zone keep their local-time meaning", async () => {
  await mount(status.clock, "Asia/Tokyo");
  await act(async () => button().props.onClick());
  await change("2030-01-01T09:01");
  await settle();
  expect(changes).toEqual(["2030-01-01T09:01"]);
});

test("closing and unmounting the panel stop canonical clock polling", async () => {
  await mountPanel();
  expect(polls()).toHaveLength(1);
  await act(async () =>
    renderer!.root.findByType("details").props.onToggle({ currentTarget: { open: false } }),
  );
  expect(polls()).toHaveLength(0);
  await act(async () =>
    renderer!.root.findByType("details").props.onToggle({ currentTarget: { open: true } }),
  );
  expect(polls()).toHaveLength(1);
  await act(async () => renderer!.unmount());
  renderer = undefined;
  expect(intervals.size).toBe(0);
});

test("a stale poll reply cannot replace a clock mutation that started after the read", async () => {
  await mountPanel();
  let finishRead = (_status: typeof status) => {};
  nextRead = new Promise<typeof status>((resolve) => (finishRead = resolve));
  await poll();
  let finishSet = () => {};
  blockedSet = new Promise<void>((resolve) => (finishSet = resolve));
  await act(async () => renderer!.root.findByType(ClockControl).props.onChange("2035-06-01T09:30"));
  expect(calls.at(-1)?.option).toBe("clock");
  await act(async () => finishRead({ ...initialStatus }));
  expect(renderer!.root.findByType(ClockControl).props.value).toBe("2035-06-01T09:30");
  status.clock = "2035-06-01T09:30:00+09:00";
  await act(async () => finishSet());
  expect(renderer!.root.findByType(ClockControl).props.value).toBe(status.clock);
});
