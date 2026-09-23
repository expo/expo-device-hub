import { afterEach, expect, mock, test } from "bun:test";
import type { ComponentProps, ReactElement } from "react";
import type { SimulatorView } from "../../client/simulator/SimulatorView";

// Run the panel's effects and decoder callbacks without a browser or live feed.
type Effect = { deps?: unknown[]; cleanup?: () => void };
const refs: Array<{ current: unknown }> = [];
const effects: Effect[] = [];
let refIndex = 0;
let effectIndex = 0;
const react = await import("react");
mock.module("react", () => ({
  ...react,
  useRef: (current: unknown) => refs[refIndex++] ?? (refs[refIndex - 1] = { current }),
  useCallback: (callback: unknown) => callback,
  useState: (value: unknown) => [value, () => {}],
  useEffect: (run: () => void | (() => void), deps: unknown[]) => {
    const index = effectIndex++;
    const previous = effects[index];
    if (previous?.deps?.length === deps.length && deps.every((value, i) => Object.is(value, previous.deps![i]))) return;
    previous?.cleanup?.();
    effects[index] = { deps, cleanup: run() || undefined };
  },
}));
mock.module("../../client/simulator/SimulatorView", () => ({ SimulatorView: () => null }));
mock.module("../../client/hooks/use-mjpeg-stream", () => ({ useMjpegStream: () => ({}) }));
mock.module("../../client/hooks/use-webrtc-stream", () => ({ useWebRtcStream: () => ({}) }));
const { DuoPanelStreams } = await import("../../client/components/duo-panel-streams");
type Props = ComponentProps<typeof DuoPanelStreams>;
type View = ReactElement<ComponentProps<typeof SimulatorView>>;
type Panel = ReactElement<Props & { screenId: 1 | 3 }> & { type: (props: Props & { screenId: 1 | 3 }) => ReactElement<{ children: View }> };
const timers = new Map<number, () => void>();
let timerId = 0;
let failures = 0;
const props: Props = {
  streamUrl: "http://localhost/helper/device/stream.avcc", mode: "avcc", activeScreenId: 1, codec: "h264",
  onStreamingChange: () => {}, onAvccError: () => { failures++; },
  onWebRtcFailure: () => {}, onWebRtcPeerChange: () => {},
};
const children = (DuoPanelStreams(props) as ReactElement<{ children: Panel[] }>).props.children;
effects.length = 0;
function render(overrides: Partial<Props> = {}) {
  const panel = children[0]!;
  refIndex = effectIndex = 0;
  const originalSet = globalThis.setTimeout;
  const originalClear = globalThis.clearTimeout;
  globalThis.setTimeout = ((callback: () => void) => { timers.set(++timerId, callback); return timerId; }) as unknown as typeof setTimeout;
  globalThis.clearTimeout = ((id: number) => { timers.delete(id); }) as unknown as typeof clearTimeout;
  try { return panel.type({ ...panel.props, ...overrides }).props.children.props; }
  finally { globalThis.setTimeout = originalSet; globalThis.clearTimeout = originalClear; }
}
function timeout() {
  const pending = [...timers.values()];
  timers.clear();
  for (const callback of pending) callback();
}
afterEach(() => { effects.length = refs.length = 0; timers.clear(); failures = 0; });

test("a silent inactive panel cannot downgrade the session", () => {
  render({ activeScreenId: 3 });
  timeout();
  expect(failures).toBe(0);
});
test("switching away cancels the pending startup timeout", () => {
  render();
  render({ activeScreenId: 3 });
  timeout();
  expect(failures).toBe(0);
});
test("a newly displayed panel gets a startup window", () => {
  render({ activeScreenId: 3 });
  timeout();
  render();
  timeout();
  expect(failures).toBe(1);
});
test("a previously decoded panel can go idle and return without downgrading", () => {
  render().onAvccDecodedFrame?.();
  render({ activeScreenId: 3 });
  render();
  timeout();
  expect(failures).toBe(0);
});
test("changing the source resets startup health", () => {
  render().onAvccDecodedFrame?.();
  render({ streamUrl: "http://localhost/helper/another/stream.avcc" });
  timeout();
  expect(failures).toBe(1);
});
test("actual decoder errors still request fallback after decoding", () => {
  const view = render();
  view.onAvccDecodedFrame?.();
  view.onAvccError?.();
  expect(failures).toBe(1);
});
