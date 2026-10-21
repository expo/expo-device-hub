import { afterEach, expect, test } from "bun:test";
import {
  type DeviceHinge,
  type HingeCommandEvent,
  type HingeControlCommand,
  type ScreenSize,
} from "@expo/hub-client";
import { act, create, type ReactTestRenderer } from "react-test-renderer";

import { duoInitialView, duoPresetView, duoRotateView } from "../foldable/duo-view";
import { recordDuoDeparture, useDuoFraming } from "../foldable/useDuoFraming";

const COVER: ScreenSize = {
  width: 1398,
  height: 2034,
  orientation: "portrait",
  screenId: 1,
  supportsHingeAngle: true,
  hingeAngle: 0,
  hingePose: "closed",
  tableMode: false,
};
const INNER_OPEN: ScreenSize = {
  ...COVER,
  width: 2007,
  height: 2853,
  screenId: 3,
  hingeAngle: 180,
  hingePose: "open",
};

let renderer: ReactTestRenderer | undefined;
afterEach(async () => {
  if (renderer) await act(async () => renderer?.unmount());
  renderer = undefined;
});

/**
 * hub-client's hinge as the model sees it: fold state plus the command events
 * that `ios-hinge.test.tsx` pins for each scenario.
 */
async function mount(screen: ScreenSize | null = COVER) {
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  const listeners = new Set<(event: HingeCommandEvent) => void>();
  let state: Partial<DeviceHinge> = {};
  let current = screen;
  let framing!: ReturnType<typeof useDuoFraming>;
  const hinge = (): DeviceHinge => ({
    supported: true,
    faceDown: false,
    pending: false,
    error: null,
    setControl: () => {},
    observe: (listener) => {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    ...state,
  });
  // Stable, as the client's is, so the listener survives fold state updates.
  const observe = hinge().observe;
  function Harness({ value, screen }: { value: DeviceHinge; screen: ScreenSize | null }) {
    framing = useDuoFraming(value, screen);
    return null;
  }
  const render = () => <Harness value={{ ...hinge(), observe }} screen={current} />;
  await act(async () => {
    renderer = create(render());
  });
  return {
    view: () => framing.view,
    commands: () => framing.commands,
    emit: (event: HingeCommandEvent) =>
      act(async () => {
        for (const listener of [...listeners]) listener(event);
      }),
    /** A new client render: fold state and the confirmed screen config. */
    update: (next: Partial<DeviceHinge>, screen = current) =>
      act(async () => {
        state = { ...state, ...next };
        current = screen;
        renderer!.update(render());
      }),
    /** An event and the fold state it changes, in one task, as the client sends them. */
    emitWith: (event: HingeCommandEvent, next: Partial<DeviceHinge>) =>
      act(async () => {
        for (const listener of [...listeners]) listener(event);
        state = { ...state, ...next };
        renderer!.update(render());
      }),
  };
}

const pose = (value: "open" | "laptop" | "closed"): HingeControlCommand => ({
  control: "pose",
  value,
});
const angle = (value: number): HingeControlCommand => ({ control: "angle", value });

test("native orientation frames the model once when connecting", async () => {
  const { view, update } = await mount(INNER_OPEN);
  const initial = duoInitialView(180, "open", INNER_OPEN);
  expect(view()).toEqual(initial);
  // Later configs do not reframe it.
  await update({}, { ...INNER_OPEN, orientation: "landscape_left" });
  expect(view()).toEqual(initial);
});

test("a rejected preset restores the view it replaced, unless a rotation superseded it", async () => {
  const { view, emit } = await mount(INNER_OPEN);
  const openView = view();
  expect(openView.fixedLeftFold).toBeUndefined();

  const laptop = pose("laptop");
  await emit({ type: "requested", command: laptop });
  expect(view().fixedLeftFold).toBeDefined();
  await emit({ type: "sent", command: laptop, display: 3 });
  await emit({ type: "acknowledged", command: laptop, ok: false });
  await emit({ type: "failed", error: "Simulator could not change the device pose." });
  expect(view()).toEqual(openView);

  // A rotation during the request owns the view; the rejection keeps it.
  const again = pose("laptop");
  await emit({ type: "requested", command: again });
  await emit({ type: "rotated" });
  const rotatedView = view();
  expect(rotatedView).not.toEqual(openView);
  await emit({ type: "failed", error: "Rejected" });
  expect(view()).toEqual(rotatedView);

  // An acknowledged preset keeps its own view: a later failed edit does not undo it.
  const open = pose("open");
  await emit({ type: "requested", command: open });
  await emit({ type: "acknowledged", command: open, ok: true });
  const acknowledged = view();
  await emit({ type: "requested", command: angle(120) });
  await emit({ type: "failed", error: "Rejected" });
  expect(view()).toEqual(acknowledged);

  // A preset queued behind a failing edit is discarded with the queue, so its view goes too.
  const beforeEdit = view();
  await emit({ type: "requested", command: angle(100) });
  await emit({ type: "requested", command: pose("laptop") });
  expect(view().fixedLeftFold).toBeDefined();
  await emit({ type: "failed", error: "Rejected" });
  expect(view()).toEqual(beforeEdit);
});

test("a queued preset failure restores the last accepted preset's view", async () => {
  const { view, emit } = await mount(COVER);
  const open = pose("open");
  const laptop = pose("laptop");
  // The sequence hub-client reports for a rejection, a timeout, or a lost connection.
  await emit({ type: "requested", command: open });
  await emit({ type: "sent", command: open, display: 3 });
  const acceptedView = view();
  await emit({ type: "requested", command: laptop });
  const laptopView = view();
  expect(laptopView).not.toEqual(acceptedView);
  await emit({ type: "acknowledged", command: open, ok: true });
  await emit({ type: "sent", command: laptop, display: 3 });
  // Acknowledging Open must not interrupt the optimistic Laptop view.
  expect(view()).toEqual(laptopView);
  await emit({ type: "failed", error: "Device control timed out." });
  expect(view()).toEqual(acceptedView);
});

test("a rotation supersedes recovery even when an earlier queued preset succeeds", async () => {
  const { view, emit } = await mount(COVER);
  const open = pose("open");
  await emit({ type: "requested", command: open });
  await emit({ type: "requested", command: pose("laptop") });
  await emit({ type: "rotated" });
  const rotatedView = view();
  await emit({ type: "acknowledged", command: open, ok: true });
  await emit({ type: "failed", error: "Rejected" });
  expect(view()).toEqual(rotatedView);
});

test("a preset rejected after a rotation restores the turned view", async () => {
  const { view, emit } = await mount(COVER);
  // Open is accepted, but the helper still reports Closed when the user rotates.
  const open = pose("open");
  await emit({ type: "requested", command: open });
  await emit({ type: "acknowledged", command: open, ok: true });
  await emit({ type: "rotated" });
  const rotatedView = view();
  expect(rotatedView).toEqual(duoRotateView(duoPresetView("open"), 1));
  await emit({ type: "requested", command: pose("laptop") });
  expect(view()).not.toEqual(rotatedView);
  await emit({ type: "failed", error: "Rejected" });
  expect(view()).toEqual(rotatedView);
});

test("a preset from before a rotation, accepted later, keeps the turned recovery view", async () => {
  const { view, emit } = await mount(COVER);
  const open = pose("open");
  await emit({ type: "requested", command: open });
  await emit({ type: "rotated" });
  const rotatedView = view();
  // Laptop queues behind Open; accepting Open must not drop the turn from recovery.
  await emit({ type: "requested", command: pose("laptop") });
  await emit({ type: "acknowledged", command: open, ok: true });
  await emit({ type: "failed", error: "Rejected" });
  expect(view()).toEqual(rotatedView);
});

test("a confirmed preset becomes the baseline for the next burst", async () => {
  const { view, emit } = await mount(COVER);
  const open = pose("open");
  await emit({ type: "requested", command: open });
  await emit({ type: "acknowledged", command: open, ok: true });
  await emit({ type: "confirmed" });
  const confirmed = view();
  await emit({ type: "requested", command: pose("laptop") });
  await emit({ type: "failed", error: "Rejected" });
  expect(view()).toEqual(confirmed);
});

test("actual submissions count panel departures by the display they elect", async () => {
  const { commands, emit, update } = await mount(COVER);
  expect(commands()).toEqual({ pending: false, coverDepartures: 0, innerDepartures: 0 });
  // An away and a return in one burst both count, even if no render shows the away.
  await emit({ type: "sent", command: angle(55), display: 3 });
  await emit({ type: "sent", command: angle(0), display: 1 });
  // Table Mode and the hysteresis band elect no display.
  await emit({ type: "sent", command: { control: "table", value: true } });
  await update({ pending: true });
  expect(commands()).toEqual({ pending: true, coverDepartures: 1, innerDepartures: 1 });
  expect(recordDuoDeparture({ coverDepartures: 0, innerDepartures: 0 }, undefined)).toEqual({
    coverDepartures: 0,
    innerDepartures: 0,
  });
});

test("a device turned over elsewhere is framed as on connect, but a local rotation turns the view", async () => {
  const { view, emit, emitWith, update } = await mount(INNER_OPEN);
  const laptop = pose("laptop");
  await emit({ type: "requested", command: laptop });
  await update({ physicalPose: "laptop" });
  await emit({ type: "acknowledged", command: laptop, ok: true });
  await emit({ type: "confirmed" });
  const laptopView = view();
  expect(laptopView).toEqual(duoPresetView("laptop"));
  // The client forgets the pose when another client turns the device.
  await update({ physicalPose: null }, { ...INNER_OPEN, hingePose: null });
  expect(view()).toEqual(duoInitialView(180, null, { ...INNER_OPEN, hingePose: null }));

  await emitWith({ type: "requested", command: pose("laptop") }, { physicalPose: "laptop" });
  const presetView = view();
  // A rotation also forgets the pose, but it turns the view instead.
  await emitWith({ type: "rotated" }, { physicalPose: null });
  expect(view()).toEqual(duoRotateView(presetView, 1));
});

test("a device turned face down elsewhere frames its cover like Tent until it turns back", async () => {
  const half = { ...INNER_OPEN, hingeAngle: 90, hingePose: null, tableMode: true };
  const { view, update } = await mount(half);
  const before = view();
  await update({}, { ...half, physicalOrientation: "facedown" });
  expect(view()).toEqual(duoPresetView("tent"));
  await update({}, { ...half, physicalOrientation: "portrait" });
  expect(view()).toEqual(before);
});

test("local commands own the framing until the device confirms them", async () => {
  const half = { ...INNER_OPEN, hingeAngle: 90, hingePose: null, tableMode: true };
  const { view, emit, update } = await mount(half);
  const before = view();
  await emit({ type: "requested", command: { control: "physical", value: "facedown" } });
  await update({}, { ...half, physicalOrientation: "facedown" });
  expect(view()).toEqual(before);
  await emit({ type: "confirmed" });
  expect(view()).toEqual(before);
});
