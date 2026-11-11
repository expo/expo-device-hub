import { afterEach, expect, mock, spyOn, test } from "bun:test";
import { act, create, type ReactTestRenderer } from "react-test-renderer";
import * as realControl from "../../socket/client-control";

const status = { clock: "2030-01-01T09:00:00+09:00", "time-zone": "Asia/Tokyo" };
const calls: Array<{ device: string; option?: string; value?: string }> = [];
let setError: string | null = null;
mock.module("../../socket/client-control", () => ({
  ...realControl,
  hostUiRequest: async (request: { device: string; option?: string; value?: string }) => {
    calls.push(request);
    if (request.option && setError) throw new Error(setError);
    return request.option ? undefined : { ...status };
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
const field = () => renderer!.root.findByType("input");
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

test("a browser without the simulator zone still ticks using the reported offset", async () => {
  await mount(status.clock, "unavailable/browser-zone");
  await advance(60_000);
  expect(button().props.children).toBe("2030-01-01 09:01");
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
