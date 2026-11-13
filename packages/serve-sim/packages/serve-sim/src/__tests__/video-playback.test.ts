import { afterAll, expect, test } from "bun:test";
import { observeVideoPlayback, type VideoPlaybackIssue } from "../client/simulator/video-playback";

const originalDocument = globalThis.document;
const doc = Object.assign(new EventTarget(), { hidden: false });
Object.assign(globalThis, { document: doc });
afterAll(() => {
  Object.assign(globalThis, { document: originalDocument });
});

class Video extends EventTarget {
  srcObject: object | null = {};
  paused = true;
  ended = false;
  reject: string | null = "NotAllowedError";
  calls = 0;
  play = () => {
    this.calls++;
    if (this.reject) return Promise.reject(Object.assign(new Error(), { name: this.reject }));
    this.paused = false;
    this.dispatchEvent(new Event("playing"));
    return Promise.resolve();
  };
}
const flush = async () => {
  await Promise.resolve();
  await Promise.resolve();
};
function setup(video = new Video()) {
  const issues: VideoPlaybackIssue[] = [];
  const control = observeVideoPlayback(video as unknown as HTMLVideoElement, (issue) =>
    issues.push(issue),
  );
  return { video, issues, control };
}

test("blocked autoplay offers recovery, and a synchronous click starts the same video", async () => {
  const { video, issues, control } = setup();
  await flush();
  expect(issues.at(-1)).toEqual("blocked");
  const source = video.srcObject;
  video.reject = null;
  const calls = video.calls;
  control.play();
  expect(video.calls).toBe(calls + 1);
  await flush();
  expect(issues.at(-1)).toBeNull();
  expect(video.srcObject).toBe(source);
  control.dispose();
});

test("a rejected manual retry keeps the recovery control", async () => {
  const { issues, control } = setup();
  await flush();
  control.play();
  await flush();
  expect(issues.at(-1)).toEqual("blocked");
  control.dispose();
});

test("other play errors get a retry state", async () => {
  const video = new Video();
  video.reject = "NotSupportedError";
  const { issues, control } = setup(video);
  await flush();
  expect(issues.at(-1)).toEqual("error");
  control.dispose();
});

test("a late rejection cannot change a replaced or disposed view", async () => {
  const video = new Video();
  let reject!: (reason: unknown) => void;
  video.play = () =>
    new Promise((_, fail) => {
      reject = fail;
    });
  const { issues, control } = setup(video);
  video.srcObject = {};
  reject({ name: "NotAllowedError" });
  await flush();
  expect(issues).toEqual([]);
  control.play();
  control.dispose();
  reject({ name: "NotAllowedError" });
  await flush();
  expect(issues).toEqual([]);
});

test("metadata starts a newly attached source, and later pauses offer recovery", async () => {
  const video = new Video();
  video.srcObject = null;
  const { issues, control } = setup(video);
  expect(video.calls).toBe(0);
  video.srcObject = {};
  video.dispatchEvent(new Event("loadedmetadata"));
  await flush();
  expect(issues.at(-1)).toEqual("blocked");
  video.reject = null;
  control.play();
  await flush();
  video.paused = true;
  video.dispatchEvent(new Event("pause"));
  expect(issues.at(-1)).toEqual("blocked");
  control.dispose();
});

test("a queued pause event does not cover video that has already resumed", async () => {
  const { video, issues, control } = setup();
  await flush();
  video.reject = null;
  control.play();
  await flush();
  video.dispatchEvent(new Event("pause"));
  expect(issues.at(-1)).toBeNull();
  control.dispose();
});

test("a queued playing event cannot dismiss the prompt for a paused video", async () => {
  const { video, issues, control } = setup();
  await flush();
  video.dispatchEvent(new Event("playing"));
  expect(issues.at(-1)).toEqual("blocked");
  control.dispose();
});
