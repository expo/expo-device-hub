import { afterEach, expect, test } from "bun:test";

import {
  canvasFrameNumber,
  carryCanvasFrame,
  forgetCanvasFrames,
  markCanvasFrame,
} from "../canvas-frames";
import { MsePlayer } from "../mse-player";
import { createGlobalStubs } from "./test-globals";

/** A canvas whose content is one value: the last image drawn onto it. */
class FakeCanvas {
  width = 300;
  height = 150;
  content: unknown = null;
  getContext() {
    return {
      drawImage: (image: FakeCanvas | FakeVideo) => {
        this.content = image instanceof FakeCanvas ? image.content : image.currentTime;
      },
    };
  }
}

class FakeVideo {
  muted = false;
  defaultMuted = false;
  autoplay = false;
  playsInline = false;
  paused = false;
  readyState = 4;
  videoWidth = 1080;
  videoHeight = 2424;
  currentTime = 0;
  playbackRate = 1;
  style = { cssText: "" };
  buffered = { length: 0 };
  src = "";
  setAttribute() {}
  addEventListener() {}
  removeEventListener() {}
  getVideoPlaybackQuality() {
    return { totalVideoFrames: 0 };
  }
}

const canvas = () => new FakeCanvas() as unknown as HTMLCanvasElement;
const content = (target: HTMLCanvasElement) => (target as unknown as FakeCanvas).content;

const { stubGlobal, restoreGlobals } = createGlobalStubs();
afterEach(restoreGlobals);

test("a replacement canvas starts from the last frame painted into the canvas it replaces", () => {
  const old = canvas();
  const replacement = canvas();
  // Nothing was painted yet, so there is nothing to carry.
  expect(carryCanvasFrame(old, replacement)).toBe(false);

  Object.assign(old, { width: 1080, height: 2424, content: "home screen" });
  markCanvasFrame(old);
  expect(canvasFrameNumber(old)).toBe(1);
  expect(carryCanvasFrame(old, replacement)).toBe(true);
  expect(content(replacement)).toBe("home screen");
  expect([replacement.width, replacement.height]).toEqual([1080, 2424]);
  expect(canvasFrameNumber(replacement)).toBe(1);

  // A canvas whose frames belong to an earlier session is not carried.
  forgetCanvasFrames(old);
  expect(canvasFrameNumber(old)).toBeUndefined();
  expect(carryCanvasFrame(old, canvas())).toBe(false);
});

test("the MSE player keeps drawing into the canvas that replaced its first one, and draws a stalled frame once", () => {
  const video = new FakeVideo();
  const frames: Array<() => void> = [];
  stubGlobal("document", { createElement: () => video, body: { appendChild() {} } });
  stubGlobal(
    "MediaSource",
    class {
      readyState = "closed";
      addEventListener() {}
    },
  );
  stubGlobal("URL", { createObjectURL: () => "blob:mse", revokeObjectURL() {} });
  stubGlobal("requestAnimationFrame", (callback: () => void) => frames.push(callback));
  stubGlobal("cancelAnimationFrame", () => {});
  const tick = () => frames.shift()!();

  let target = canvas();
  const first = target;
  let firstFrames = 0;
  const player = new MsePlayer(() => target, { onFirstFrame: () => firstFrames++ });
  video.currentTime = 1;
  tick();
  expect(content(first)).toBe(1);
  expect([first.width, first.height]).toEqual([1080, 2424]);
  expect(canvasFrameNumber(first)).toBe(1);

  // The view switches between 2D and 3D: a new canvas replaces the first one.
  target = canvas();
  tick();
  expect(content(target)).toBe(1);
  expect([target.width, target.height]).toEqual([1080, 2424]);
  video.currentTime = 2;
  tick();
  expect(content(target)).toBe(2);
  expect(content(first)).toBe(1);
  expect(firstFrames).toBe(1);

  // A still Android screen stalls the video: the frame is not drawn again.
  tick();
  tick();
  expect(canvasFrameNumber(target)).toBe(2);
  player.destroy();
});
