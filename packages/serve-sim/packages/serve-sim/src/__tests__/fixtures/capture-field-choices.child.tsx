import { afterEach, expect, mock, test } from "bun:test";
import { act, create, type ReactTestRenderer } from "react-test-renderer";

import * as realClientControl from "../../socket/client-control";
import * as realCaptureStream from "../../client/hooks/use-capture-stream";
import type { CaptureMeta } from "../../capture/store";

// Drive the real panel with its two I/O edges replaced: the capture stream reports what the panel
// last heard about each device, and host actions answer from what the server actually runs.
const SERVER_DEFAULT = ["response-body"];
const attachments = new Map<string, CaptureMeta["attachment"]>();
// Devices whose stream has not sent its first frame yet, and those whose stream failed.
const pending = new Set<string>();
const failed = new Set<string>();
// Devices the server captures or is starting, whatever the panel last heard, and devices whose
// field write fails.
const serverCapturing = new Set<string>();
const serverStarting = new Set<string>();
const failingWrites = new Set<string>();
const calls: Array<{ action: string; params: Record<string, unknown> }> = [];

function meta(attachment: CaptureMeta["attachment"], fields: string[]): CaptureMeta {
  return { attachment, fields, attachError: null, droppedOversizedBodies: 0 } as unknown as CaptureMeta;
}

mock.module("../../client/hooks/use-capture-stream", () => ({
  ...realCaptureStream,
  useCaptureStream: (path: string) => {
    const udid = new URL(path, "http://preview").searchParams.get("device") ?? "";
    return {
      meta: pending.has(udid) ? null : meta(attachments.get(udid) ?? "not-enabled", SERVER_DEFAULT),
      requests: [],
      errored: failed.has(udid),
      clear: async () => {},
      setMeta: () => {},
    };
  },
}));
mock.module("../../socket/client-control", () => ({
  ...realClientControl,
  runHostAction: async (action: string, params: Record<string, unknown>) => {
    calls.push({ action, params });
    const udid = params.udid as string;
    if (action === "capture.fields") {
      if (failingWrites.has(udid)) return { exitCode: 1, stdout: "", stderr: "ENOSPC: no space left on device" };
      if (serverStarting.has(udid)) return { exitCode: 0, stderr: "", stdout: JSON.stringify(meta("starting", SERVER_DEFAULT)) };
      if (!serverCapturing.has(udid)) {
        return {
          exitCode: 1,
          stdout: JSON.stringify(meta("not-enabled", SERVER_DEFAULT)),
          stderr: "Network capture is not on for this device. Enable it first.",
        };
      }
    }
    serverCapturing.add(udid);
    const fields = (params.fields as string[] | undefined) ?? SERVER_DEFAULT;
    return { exitCode: 0, stderr: "", stdout: JSON.stringify(meta("capturing", fields)) };
  },
}));

const { CaptureFieldsMenu, NetworkCaptureTool } = await import("../../client/components/network-capture-tool");
const { chooseCaptureFields, chosenCaptureFields } = await import("../../client/hooks/use-capture-field-choices");

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

let renderer: ReactTestRenderer | undefined;
afterEach(async () => {
  if (renderer) await act(async () => renderer?.unmount());
  renderer = undefined;
  attachments.clear();
  pending.clear();
  failed.clear();
  serverCapturing.clear();
  serverStarting.clear();
  failingWrites.clear();
  calls.length = 0;
});

function panel(udid: string) {
  return <NetworkCaptureTool udid={udid} captureEndpoint={`/network-capture?device=${udid}`} />;
}

async function mount(udid: string) {
  await act(async () => {
    renderer = create(panel(udid));
  });
}

function shownFields(): readonly string[] {
  return renderer!.root.findByType(CaptureFieldsMenu).props.fields;
}

// The menu's options render through a portal into document.body, which the test renderer cannot
// mount, so a pick goes through the menu's onChange.
async function pick(fields: string[]) {
  await act(async () => renderer!.root.findByType(CaptureFieldsMenu).props.onChange(fields));
}

/** The params of each `action` the panel sent. */
function sent(action: string) {
  return calls.filter((call) => call.action === action).map((call) => call.params);
}

async function press(label: string) {
  const button = renderer!.root.find((node) => node.type === "button" && node.props.children === label);
  await act(async () => button.props.onClick());
}

test("keeps each simulator's pick, and an empty pick, apart from the others", () => {
  chooseCaptureFields("STORE-A", []);
  chooseCaptureFields("STORE-B", ["header"]);
  expect(chosenCaptureFields("STORE-A")).toEqual([]);
  expect(chosenCaptureFields("STORE-B")).toEqual(["header"]);
  expect(chosenCaptureFields("STORE-C")).toBeNull();
});

// The preview unmounts the device view while a switch loads, so each visit mounts the panel anew.
async function visit(udid: string) {
  if (renderer) await act(async () => renderer!.unmount());
  await mount(udid);
}

test("keeps A's metadata-only pick after an edit on B, and enables A with it", async () => {
  await visit("SIM-A");
  await pick([]);
  await visit("SIM-B");
  expect(shownFields()).toEqual(SERVER_DEFAULT);
  await pick(["header"]);
  await visit("SIM-A");

  expect(shownFields()).toEqual([]);
  await press("Enable capture");
  expect(sent("capture.enable")).toEqual([{ udid: "SIM-A", fields: [] }]);
});

test("keeps the pick when the Tools panel closes and reopens", async () => {
  await mount("SIM-C");
  await pick([]);
  // The Tools panel unmounts its content when it closes.
  await act(async () => renderer!.unmount());
  await mount("SIM-C");

  expect(shownFields()).toEqual([]);
  await press("Enable capture");
  expect(sent("capture.enable")).toEqual([{ udid: "SIM-C", fields: [] }]);
});

test("enables with the server's default the menu shows when no pick was made", async () => {
  await mount("SIM-D");
  expect(shownFields()).toEqual(SERVER_DEFAULT);
  await press("Enable capture");
  expect(calls).toEqual([{ action: "capture.enable", params: { udid: "SIM-D", fields: SERVER_DEFAULT } }]);
});

test("restarts a failed capture with the metadata-only pick", async () => {
  attachments.set("SIM-F", "failed");
  await mount("SIM-F");
  await pick([]);
  await press("Restart with capture");

  expect(sent("capture.reboot")).toEqual([{ udid: "SIM-F", enabled: true, fields: [] }]);
});

test("remembers a live change, so a later restart keeps what the menu shows", async () => {
  attachments.set("SIM-E", "capturing");
  serverCapturing.add("SIM-E");
  await mount("SIM-E");
  await pick(["query"]);

  expect(calls).toEqual([{ action: "capture.fields", params: { udid: "SIM-E", fields: ["query"] } }]);
  expect(chosenCaptureFields("SIM-E")).toEqual(["query"]);
});

test("sends a pick made before the first frame to a running capture", async () => {
  pending.add("SIM-G");
  serverCapturing.add("SIM-G");
  await mount("SIM-G");
  await pick([]);

  expect(calls).toEqual([{ action: "capture.fields", params: { udid: "SIM-G", fields: [] } }]);
  expect(chosenCaptureFields("SIM-G")).toEqual([]);
});

test("sends a pick to a capture that started after the panel's last frame", async () => {
  // The panel last heard "off", then its stream dropped, and another viewer turned capture on.
  failed.add("SIM-H");
  serverCapturing.add("SIM-H");
  await mount("SIM-H");
  await pick([]);

  expect(calls).toEqual([{ action: "capture.fields", params: { udid: "SIM-H", fields: [] } }]);
});

test("restarts with what the menu shows when the stream failed before its first frame", async () => {
  pending.add("SIM-I");
  failed.add("SIM-I");
  await mount("SIM-I");
  expect(shownFields()).toEqual([]);
  await press("Restart with capture");
  expect(sent("capture.reboot")).toEqual([{ udid: "SIM-I", enabled: true, fields: [] }]);

  await act(async () => renderer!.unmount());
  serverCapturing.clear();
  serverStarting.clear();
  failingWrites.clear();
  calls.length = 0;
  await mount("SIM-I");
  await pick(["header"]);
  expect(shownFields()).toEqual(["header"]);
  await press("Restart with capture");
  expect(sent("capture.reboot")).toEqual([{ udid: "SIM-I", enabled: true, fields: ["header"] }]);
});

test("hands a pick to a capture another viewer is starting", async () => {
  serverStarting.add("SIM-J");
  await mount("SIM-J");
  await pick([]);

  expect(calls).toEqual([{ action: "capture.fields", params: { udid: "SIM-J", fields: [] } }]);
  expect(chosenCaptureFields("SIM-J")).toEqual([]);
  expect(shownFields()).toEqual([]);
});

test("reports a failed field write instead of keeping the pick as if capture were off", async () => {
  failingWrites.add("SIM-K");
  await mount("SIM-K");
  await pick([]);

  expect(chosenCaptureFields("SIM-K")).toBeNull();
  expect(shownFields()).toEqual(SERVER_DEFAULT);
  const error = renderer!.root.find((node) => node.type === "span" && node.props.children === "ENOSPC: no space left on device");
  expect(error).toBeDefined();
});
