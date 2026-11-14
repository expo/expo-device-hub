import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";
import type { spawn } from "node:child_process";
import { expect, test } from "bun:test";
import {
  getShownOrientation,
  ORIENTATION_EVENT_TAGS,
  parseActivityRotation,
  parseFixedRotationApp,
  watchOrientationEvents,
} from "../src/adb.ts";
import type { execText } from "../src/exec.ts";

function fakeLogcat() {
  const stdout = new PassThrough();
  const child = Object.assign(new EventEmitter(), {
    stdout,
    signals: [] as string[],
    kill(signal: string) {
      child.signals.push(signal);
      stdout.end();
      child.emit("close", null, signal);
      return true;
    },
  });
  const calls: { command: string; args: string[] }[] = [];
  const runSpawn = ((command: string, args: string[]) => {
    calls.push({ command, args });
    return child;
  }) as unknown as typeof spawn;
  return { child, calls, runSpawn };
}

const wait = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

test("follows the configuration and activity events of the device's events log", async () => {
  const { child, calls, runSpawn } = fakeLogcat();
  const controller = new AbortController();
  let changes = 0;
  const watching = watchOrientationEvents(
    "emulator-5554",
    () => changes++,
    controller.signal,
    runSpawn,
  );
  expect(calls).toEqual([
    {
      command: "adb",
      args: [
        "-s",
        "emulator-5554",
        "logcat",
        "-b",
        "events",
        "-v",
        "brief",
        "-T",
        "1",
        "configuration_changed:I",
        "wm_task_to_front:I",
        "wm_task_moved:I",
        "wm_task_removed:I",
        "wm_create_activity:I",
        "wm_restart_activity:I",
        "wm_set_resumed_activity:I",
        "wm_finish_activity:I",
        "*:S",
      ],
    },
  ]);
  expect(ORIENTATION_EVENT_TAGS[0]).toBe("configuration_changed");
  child.stdout.write("--------- beginning of events\n");
  await wait(1);
  expect(changes).toBe(0);
  // A line split between two reads counts once it is complete.
  child.stdout.write("I/configuration_changed(  636): 5368");
  await wait(1);
  expect(changes).toBe(0);
  child.stdout.write("72064\n");
  await wait(1);
  expect(changes).toBe(1);
  // A half turn changes only the window configuration, and is still an event.
  child.stdout.write("I/configuration_changed(  636): 536870912\n");
  await wait(1);
  expect(changes).toBe(2);
  // An app that opens can turn before the display does.
  child.stdout.write(
    "I/wm_create_activity(  651): [0,114342506,7,com.google.android.gm/.ConversationListActivityGmail]\n",
  );
  await wait(1);
  expect(changes).toBe(3);

  controller.abort();
  await watching;
  expect(child.signals).toEqual(["SIGTERM"]);
});

test("settles when logcat exits, and starts nothing after an abort", async () => {
  const { child, runSpawn, calls } = fakeLogcat();
  const watching = watchOrientationEvents(
    "emulator-5554",
    () => {},
    new AbortController().signal,
    runSpawn,
  );
  child.emit("close", 1, null);
  await watching;

  const aborted = new AbortController();
  aborted.abort();
  await watchOrientationEvents("emulator-5554", () => {}, aborted.signal, runSpawn);
  expect(calls).toHaveLength(1);
});

test("rejects when adb cannot start", async () => {
  const { child, runSpawn } = fakeLogcat();
  const watching = watchOrientationEvents(
    "emulator-5554",
    () => {},
    new AbortController().signal,
    runSpawn,
  );
  child.emit("error", new Error("spawn adb ENOENT"));
  await expect(watching).rejects.toThrow("ENOENT");
});

function result(stdout: string) {
  return { status: 0, signal: null, stdout, stderr: "", timedOut: false, error: null };
}

// Shortened from `dumpsys window displays` on emulator 37.2.7 (Android 17) while Gmail opened in
// landscape from the portrait launcher.
const DISPLAYS_TURNING = `WINDOW MANAGER DISPLAY CONTENTS (dumpsys window displays)
  Display: mDisplayId=0 (organized)
  init=720x1600 300dpi base=720x1600 300dpi cur=720x1600 app=720x1600 rng=720x672-1600x1552
  overrideConfig={1.0 310mcc260mnc [en_US] ldltr sw384dp w384dp h853dp 300dpi nrml long port finger winConfig={ mBounds=Rect(0, 0 - 720, 1600) mDisplayRotation=ROTATION_0 mWindowingMode=fullscreen mRotation=ROTATION_0}}
  mFocusedApp=ActivityRecord{114342506 u0 com.google.android.gm/.ConversationListActivityGmail t7}
  mFixedRotationLaunchingApp=ActivityRecord{114342506 u0 com.google.android.gm/.ConversationListActivityGmail t7}
  AsyncRotationController
    mOriginalRotation=0
  DisplayRotation
    mRotation=0 mDeferredRotationPauseCount=0
`;

const DISPLAYS_STILL = DISPLAYS_TURNING.replace(
  /\n *mFixedRotationLaunchingApp=.*\n *AsyncRotationController\n *mOriginalRotation=0/,
  "\n  mFixedRotationLaunchingApp=null",
);

// Shortened from `dumpsys activity activities` at the same moment.
const ACTIVITIES = `ACTIVITY MANAGER ACTIVITIES (dumpsys activity activities)
Display #0 (activities from top to bottom):
  * Task{7a7db5b #7 type=standard A=10170:com.google.android.gm U=0 visible=true}
    topResumedActivity=ActivityRecord{114342506 u0 com.google.android.gm/.ConversationListActivityGmail t7}
    * Hist  #0: ActivityRecord{114342506 u0 com.google.android.gm/.ConversationListActivityGmail t7}
      mLastReportedConfigurations:
        mGlobalConfig={1.0 port winConfig={ mBounds=Rect(0, 0 - 720, 1600) mDisplayRotation=ROTATION_0 mRotation=ROTATION_0}}
        mOverrideConfig={1.0 land winConfig={ mBounds=Rect(0, 0 - 1600, 720) mDisplayRotation=ROTATION_270 mRotation=ROTATION_270}}
      CurrentConfiguration={1.0 land winConfig={ mBounds=Rect(0, 0 - 1600, 720) mDisplayRotation=ROTATION_270 mRotation=ROTATION_270}}
  * Task{ba342ef #2 type=home}
    * Hist  #0: ActivityRecord{153418597 u0 com.google.android.apps.nexuslauncher/.NexusLauncherActivity t2}
      CurrentConfiguration={1.0 port winConfig={ mBounds=Rect(0, 0 - 720, 1600) mRotation=ROTATION_0}}
`;

function fakeAdb(displays: string, activities: string = ACTIVITIES) {
  const calls: string[] = [];
  const runExec = (async (_command, args) => {
    const shell = args.slice(3).join(" ");
    calls.push(shell);
    if (shell === "wm size") return result("Physical size: 720x1600\n");
    if (shell === "dumpsys window displays") return result(displays);
    if (shell === "dumpsys activity activities") return result(activities);
    throw new Error(`unexpected command ${shell}`);
  }) as typeof execText;
  return { calls, runExec };
}

test("names an app that Android turns before the display, and its rotation", () => {
  expect(parseFixedRotationApp(DISPLAYS_TURNING)).toBe("114342506");
  expect(parseFixedRotationApp(DISPLAYS_STILL)).toBe(null);
  expect(parseActivityRotation(ACTIVITIES, "114342506")).toBe(3);
  expect(parseActivityRotation(ACTIVITIES, "153418597")).toBe(0);
  expect(parseActivityRotation(ACTIVITIES, "deadbeef")).toBe(null);
});

test("reads the pose of an app that opens turned, before the display turns", async () => {
  const { calls, runExec } = fakeAdb(DISPLAYS_TURNING);
  await expect(getShownOrientation("emulator-5554", runExec)).resolves.toEqual({
    orientation: "landscape_left",
    settling: true,
  });
  expect(calls).toContain("dumpsys activity activities");
});

test("reads only the display while no app is turned before it", async () => {
  const { calls, runExec } = fakeAdb(DISPLAYS_STILL);
  await expect(getShownOrientation("emulator-5554", runExec)).resolves.toEqual({
    orientation: "portrait",
    settling: false,
  });
  expect(calls).not.toContain("dumpsys activity activities");
});

test("keeps the display's pose when the turned activity is not in the activity dump", async () => {
  const { runExec } = fakeAdb(DISPLAYS_TURNING, "ACTIVITY MANAGER ACTIVITIES\n");
  await expect(getShownOrientation("emulator-5554", runExec)).resolves.toEqual({
    orientation: "portrait",
    settling: true,
  });
});
