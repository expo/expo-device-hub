import { afterEach, expect, test } from "bun:test";
import { type DeviceFold, type FoldCommandEvent, type FoldControlCommand } from "@expo/hub-client";
import { act, create, type ReactTestRenderer } from "react-test-renderer";

import { type DuoStreamConfig } from "../foldable/duo-displays";
import { duoInitialView, duoRotateView } from "../foldable/duo-view";
import { recordDuoDeparture, useDuoFraming } from "../foldable/useDuoFraming";
import { DUO_FOLD_CONTROLS, duoPreset } from "./duo-fixtures";

const COVER_SCREEN: DuoStreamConfig = {
  width: 1398,
  height: 2034,
  orientation: "portrait",
  screenId: 1,
};
const INNER_SCREEN: DuoStreamConfig = {
  width: 2007,
  height: 2853,
  orientation: "portrait",
  screenId: 3,
};

/** The screen config and the confirmed fold state that hub-client reports together. */
type Device = { screen: DuoStreamConfig | null; fold: Partial<DeviceFold> };
const FACE_UP = { faceDown: false };
const COVER: Device = {
  screen: COVER_SCREEN,
  fold: { angle: 0, pose: "closed", tableMode: { enabled: false }, physical: FACE_UP },
};
const INNER_OPEN: Device = {
  screen: INNER_SCREEN,
  fold: { angle: 180, pose: "open", tableMode: { enabled: false }, physical: FACE_UP },
};
const HALF: Device = {
  screen: INNER_SCREEN,
  fold: { angle: 90, pose: null, tableMode: { enabled: true }, physical: FACE_UP },
};

let renderer: ReactTestRenderer | undefined;
afterEach(async () => {
  if (renderer) await act(async () => renderer?.unmount());
  renderer = undefined;
});

/**
 * hub-client's fold as the model sees it: fold state plus the command events
 * that `ios-hinge.test.tsx` pins for each scenario.
 */
async function mount(device: Device = COVER) {
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  const listeners = new Set<(event: FoldCommandEvent) => void>();
  let state: Partial<DeviceFold> = device.fold;
  let current = device.screen;
  let framing!: ReturnType<typeof useDuoFraming>;
  const fold = (): DeviceFold => ({
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
  const observe = fold().observe;
  function Harness({ value, screen }: { value: DeviceFold; screen: DuoStreamConfig | null }) {
    framing = useDuoFraming(value, DUO_FOLD_CONTROLS, screen);
    return null;
  }
  const render = () => <Harness value={{ ...fold(), observe }} screen={current} />;
  await act(async () => {
    renderer = create(render());
  });
  return {
    view: () => framing.view,
    commands: () => framing.commands,
    emit: (event: FoldCommandEvent) =>
      act(async () => {
        for (const listener of [...listeners]) listener(event);
      }),
    /** A new client render: fold state and the confirmed screen config. */
    update: (next: Partial<DeviceFold>, screen = current) =>
      act(async () => {
        state = { ...state, ...next };
        current = screen;
        renderer!.update(render());
      }),
    /** An event and the fold state it changes, in one task, as the client sends them. */
    emitWith: (event: FoldCommandEvent, next: Partial<DeviceFold>) =>
      act(async () => {
        for (const listener of [...listeners]) listener(event);
        state = { ...state, ...next };
        renderer!.update(render());
      }),
  };
}

const pose = (value: "open" | "laptop" | "closed"): FoldControlCommand => ({
  control: "pose",
  value,
});
const angle = (value: number): FoldControlCommand => ({ control: "angle", value });

test("native orientation frames the model once when connecting", async () => {
  const { view, update } = await mount(INNER_OPEN);
  const initial = duoInitialView(180, "open", INNER_SCREEN);
  expect(view()).toEqual(initial);
  // Later configs do not reframe it.
  await update({}, { ...INNER_SCREEN, orientation: "landscape_left" });
  expect(view()).toEqual(initial);
});

test("a rejected preset restores the view it replaced, unless a rotation superseded it", async () => {
  const { view, emit } = await mount(INNER_OPEN);
  const openView = view();
  expect(openView.fixedLeftFold).toBeUndefined();

  const laptop = pose("laptop");
  await emit({ type: "requested", command: laptop });
  expect(view().fixedLeftFold).toBeDefined();
  await emit({ type: "sent", command: laptop, display: "inner" });
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
  await emit({ type: "sent", command: open, display: "inner" });
  const acceptedView = view();
  await emit({ type: "requested", command: laptop });
  const laptopView = view();
  expect(laptopView).not.toEqual(acceptedView);
  await emit({ type: "acknowledged", command: open, ok: true });
  await emit({ type: "sent", command: laptop, display: "inner" });
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
  expect(rotatedView).toEqual(duoRotateView(duoPreset("open"), 1));
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

test("a reset drops the old connection's restore point and ownership, and frames as on connect", async () => {
  const { view, emit, update } = await mount(HALF);
  const initial = view();
  await emit({ type: "requested", command: pose("laptop") });
  expect(view()).toEqual(duoPreset("laptop"));
  await emit({ type: "reset" });
  expect(view()).toEqual(initial);
  // A later failure has nothing from the old connection to restore.
  await emit({ type: "requested", command: angle(120) });
  await emit({ type: "failed", error: "Rejected" });
  expect(view()).toEqual(initial);
  // Ownership ended too, so face-down framing follows another client again.
  await update({ physical: { faceDown: true } });
  expect(view()).toEqual(duoPreset("tent"));
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
  await emit({ type: "sent", command: angle(55), display: "inner" });
  await emit({ type: "sent", command: angle(0), display: "cover" });
  // Table Mode and the hysteresis band elect no display.
  await emit({ type: "sent", command: { control: "tableMode", value: true } });
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
  await update({ physical: { pose: "laptop", faceDown: false } });
  await emit({ type: "acknowledged", command: laptop, ok: true });
  await emit({ type: "confirmed" });
  const laptopView = view();
  expect(laptopView).toEqual(duoPreset("laptop"));
  // The client forgets the pose when another client turns the device.
  await update({ pose: null, physical: { pose: null, faceDown: false } });
  expect(view()).toEqual(duoInitialView(180, null, INNER_SCREEN));

  await emitWith(
    { type: "requested", command: pose("laptop") },
    { physical: { pose: "laptop", faceDown: false } },
  );
  const presetView = view();
  // A rotation also forgets the pose, but it turns the view instead.
  await emitWith({ type: "rotated" }, { physical: { pose: null, faceDown: false } });
  expect(view()).toEqual(duoRotateView(presetView, 1));
});

test("a device turned face down elsewhere frames its cover like Tent until it turns back", async () => {
  const { view, update } = await mount(HALF);
  const before = view();
  await update({ physical: { faceDown: true } });
  expect(view()).toEqual(duoPreset("tent"));
  await update({ physical: { faceDown: false } });
  expect(view()).toEqual(before);
});

test("local commands own the framing until the device confirms them", async () => {
  const { view, emit, update } = await mount(HALF);
  const before = view();
  await emit({ type: "requested", command: { control: "faceDown", value: true } });
  await update({ physical: { faceDown: true } });
  expect(view()).toEqual(before);
  await emit({ type: "confirmed" });
  expect(view()).toEqual(before);
});
