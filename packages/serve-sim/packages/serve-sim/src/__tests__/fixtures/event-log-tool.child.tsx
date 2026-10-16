import { afterEach, expect, mock, test } from "bun:test";
import type { ReactElement } from "react";
import type { HostEventStream } from "../../socket/client-control";

// Run the real component's effects in a child process, with controlled stream delivery.
let states: unknown[] = [], stateIndex = 0, effectIndex = 0, refIndex = 0, dirty = false;
let refs: Array<{ current: unknown }> = [];
type Effect = { dependencies?: readonly unknown[]; pending?: () => void | (() => void); cleanup?: () => void; layout?: boolean };
let effects: Effect[] = [];
function scheduleEffect(effect: () => void | (() => void), dependencies: readonly unknown[], layout = false) {
  const slot = effects[effectIndex++] ?? (effects[effectIndex - 1] = {});
  if (!slot.dependencies || dependencies.some((value, index) => !Object.is(value, slot.dependencies![index]))) {
    slot.dependencies = dependencies;
    slot.pending = effect;
    slot.layout = layout;
  }
}
const React = await import("react");
mock.module("react", () => ({
  ...React,
  useState: (initial: unknown) => {
    const index = stateIndex++;
    if (!(index in states)) states[index] = initial;
    return [states[index], (update: unknown) => {
      const next = typeof update === "function" ? update(states[index]) : update;
      if (!Object.is(states[index], next)) { states[index] = next; dirty = true; }
    }];
  },
  useRef: (initial: unknown) => refs[refIndex++] ?? (refs[refIndex - 1] = { current: initial }),
  useMemo: (create: () => unknown) => create(),
  useEffect: scheduleEffect,
  useLayoutEffect: (effect: () => void | (() => void), dependencies: readonly unknown[]) => scheduleEffect(effect, dependencies, true),
}));
const streams: Array<HostEventStream & { path: string; closed: number }> = [];
mock.module("../../client/components/collapsible-section", () => ({ CollapsibleSection: () => null }));
mock.module("../../socket/client-control", () => ({
  openHostEventStream: (path: string) => {
    const stream = { path, closed: 0, onmessage: null, onerror: null, close() { this.closed++; } };
    streams.push(stream);
    return stream;
  },
}));
const { EventLogTool } = await import("../../client/components/event-log-tool");
type Section = ReactElement<{ open: boolean; onOpenChange: (open: boolean) => void; children: unknown; summary: unknown }>;
let props = { udid: "A", eventsEndpoint: "/events/A" };
let section: Section;
function render() {
  stateIndex = effectIndex = refIndex = 0;
  dirty = false;
  section = EventLogTool(props) as Section;
  return section;
}
function flushEffects(layout: boolean) {
  for (const slot of effects) {
    if (!slot.pending || slot.layout !== layout) continue;
    const pending = slot.pending; slot.pending = undefined;
    slot.cleanup?.(); slot.cleanup = pending() || undefined;
  }
}
function flush() {
  for (let iteration = 0; iteration < 10; iteration++) {
    flushEffects(true); flushEffects(false);
    if (!dirty) return section;
    render();
  }
  throw new Error("Component did not settle");
}
function toggle(open: boolean) { section.props.onOpenChange(open); render(); return flush(); }
function deliver(stream: HostEventStream, payload: unknown) {
  stream.onmessage?.({ data: JSON.stringify(payload) });
  if (dirty) render();
  flush();
}
function event(id: number, summary = `Event ${id}`) {
  return { id, summary, timestamp: "2026-10-03T00:00:00Z", device: props.udid, source: "hid", kind: "key" };
}
function findRows(node: unknown): Array<{ id: number; summary: string }> {
  if (Array.isArray(node)) return node.flatMap(findRows);
  if (!node || typeof node !== "object") return [];
  const element = node as ReactElement<{ event?: { id: number; summary: string }; children?: unknown }>;
  return element.props?.event ? [element.props.event] : findRows(element.props?.children);
}
function rows() { return findRows(section.props.children); }
function summaryText(node: unknown): string {
  if (Array.isArray(node)) return node.map(summaryText).join("");
  if (node && typeof node === "object") return summaryText((node as ReactElement<{ children?: unknown }>).props?.children);
  return typeof node === "string" || typeof node === "number" ? String(node) : "";
}
afterEach(() => {
  for (const slot of effects) slot.cleanup?.();
  states = []; refs = []; effects = []; streams.length = 0;
  props = { udid: "A", eventsEndpoint: "/events/A" };
});

test("the collapsed section opens no stream and renders no rows", () => {
  render(); flush();
  expect(streams).toHaveLength(0);
  expect(rows()).toEqual([]);
  toggle(true);
  expect(streams.map(stream => stream.path)).toEqual(["/events/A"]);
  deliver(streams[0]!, { events: [event(1)] });
  expect(rows().map(row => row.id)).toEqual([1]);
});

test("closing retires callbacks and reopening replaces cached history with a current snapshot", () => {
  render(); flush(); toggle(true);
  const first = streams[0]!;
  deliver(first, { events: [event(1)] });
  toggle(false);
  expect(first.closed).toBe(1);
  expect(rows()).toEqual([]);
  deliver(first, { event: event(2, "Late old stream") });
  first.onerror?.();
  expect(summaryText(section.props.summary)).toContain("1");
  expect(dirty).toBe(false);
  toggle(true);
  expect(streams).toHaveLength(2);
  deliver(streams[1]!, { events: [event(1, "Updated while closed"), event(3)] });
  expect(rows().map(row => row.summary)).toEqual(["Event 3", "Updated while closed"]);
});

test("a device change hides old history before effects run, even with the same endpoint", () => {
  render(); flush(); toggle(true);
  const first = streams[0]!;
  deliver(first, { events: [event(1)] });
  props = { udid: "B", eventsEndpoint: "/events/A" };
  render();
  expect(rows()).toEqual([]);
  expect(summaryText(section.props.summary)).toContain("0");
  flushEffects(true);
  first.onmessage?.({ data: JSON.stringify({ event: event(2, "Late A") }) });
  first.onerror?.();
  expect(dirty).toBe(false);
  flush();
  expect(first.closed).toBe(1);
  expect(streams).toHaveLength(2);
  deliver(streams[1]!, { events: [event(3)] });
  expect(rows().map(row => row.id)).toEqual([3]);
});

test("changing path while collapsed clears its count and subscribes only when reopened", () => {
  render(); flush(); toggle(true);
  deliver(streams[0]!, { events: [event(1)] });
  toggle(false);
  props = { udid: "A", eventsEndpoint: "/events/new" };
  render(); flush();
  expect(streams).toHaveLength(1);
  expect(summaryText(section.props.summary)).toContain("0");
  toggle(true);
  expect(streams[1]!.path).toBe("/events/new");
});

test("live snapshots stay bounded and updates replace matching event IDs", () => {
  render(); flush(); toggle(true);
  deliver(streams[0]!, { events: Array.from({ length: 502 }, (_, id) => event(id)) });
  expect(rows()).toHaveLength(500);
  expect(rows().at(-1)?.id).toBe(2);
  deliver(streams[0]!, { event: event(300, "Updated drag") });
  expect(rows()).toHaveLength(500);
  expect(rows().filter(row => row.id === 300)).toEqual([{ ...event(300, "Updated drag") }]);
  deliver(streams[0]!, { event: event(502) });
  expect(rows()).toHaveLength(500);
  expect(rows().at(-1)?.id).toBe(3);
});
