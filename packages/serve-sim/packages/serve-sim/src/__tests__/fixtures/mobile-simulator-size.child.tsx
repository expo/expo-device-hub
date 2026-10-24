import { strict as assert } from "node:assert";
import { act, create, type ReactTestRenderer } from "react-test-renderer";
import { useMobileSimulatorSize } from "../../client/hooks/use-mobile-simulator-size";

Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
let onResize = () => {};
let disconnects = 0;
Object.assign(globalThis, {
  getComputedStyle: () => ({
    paddingTop: "56px",
    paddingBottom: "8px",
    paddingLeft: "4px",
    paddingRight: "4px",
  }),
  ResizeObserver: class {
    constructor(callback: () => void) {
      onResize = callback;
    }
    observe() {}
    disconnect() {
      disconnects++;
    }
  },
});
const page = { clientWidth: 390, clientHeight: 700 };
let actionsHeight = 58;
const actions = { getBoundingClientRect: () => ({ height: actionsHeight }) };
const pageRef = { current: page as HTMLElement };
const actionsRef = { current: actions as unknown as HTMLElement };
let result: number | null = null;
function Probe({ enabled = true, aspect = 0.5 }) {
  result = useMobileSimulatorSize(pageRef, actionsRef, enabled, aspect);
  return null;
}
let renderer: ReactTestRenderer;
await act(async () => {
  renderer = create(<Probe />);
});
assert.equal(result, 283, "fill all available portrait height rather than a saved desktop size");
page.clientHeight = 350;
await act(async () => onResize());
assert.equal(result, 108, "refit above the mobile keyboard");
actionsHeight = 0;
await act(async () => onResize());
assert.equal(result, 143, "use the toolbar and its gap when keyboard actions are hidden");
actionsHeight = 58;
await act(async () => onResize());
assert.equal(result, 108, "restore toolbar space after the keyboard closes");
actionsHeight = 116;
await act(async () => onResize());
assert.equal(result, 79, "reserve the actual wrapped controls height");
page.clientHeight = 100;
await act(async () => onResize());
assert.equal(result, 0, "do not grow when controls leave no room");
page.clientHeight = 320;
page.clientWidth = 600;
actionsHeight = 58;
await act(async () => {
  renderer.update(<Probe aspect={2} />);
});
assert.equal(result, 372, "fit a landscape stream without changing its aspect ratio");
await act(async () => {
  renderer.update(<Probe enabled={false} />);
});
assert.equal(result, null, "release mobile sizing on desktop or presentation mode");
assert.ok(disconnects >= 2, "disconnect observers on mode changes");
await act(async () => {
  renderer.unmount();
});
console.log("mobile layout sizing passed");
