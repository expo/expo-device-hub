import { afterEach, beforeEach, expect, test } from "bun:test";
import { Window } from "happy-dom";
import { act, create, type ReactTestRenderer } from "react-test-renderer";
import { useLayoutEffect } from "react";
import type { DevicePlayback } from "../types";
import { observeVideoPlayback } from "../video-playback";
import { useVideoPlayback } from "../useVideoPlayback";
import { usePlaybackRecovery, usePlaybackRecoveryWarning } from "../usePlaybackRecovery";
import { createGlobalStubs } from "./test-globals";
const { stubGlobal, restoreGlobals } = createGlobalStubs();
let dom: Window;
let renderer: ReactTestRenderer | undefined;
let video: HTMLVideoElement;
let source: MediaStream;
let denied: boolean;
let calls: number;
let latest: DevicePlayback | undefined;
let layoutAction: (() => void) | undefined;
const warnings: unknown[][] = [];
let originalWarn: typeof console.warn;
let originalEnvironment: string | undefined;
function Consumer({ playback }: { playback?: DevicePlayback }) {
  usePlaybackRecovery({ playback });
  return null;
}
function Probe({ enabled = true, consumer = true }: { enabled?: boolean; consumer?: boolean }) {
  latest = useVideoPlayback(video, source, enabled);
  useLayoutEffect(() => {
    layoutAction?.();
  });
  usePlaybackRecoveryWarning(latest);
  return consumer ? <Consumer playback={latest} /> : null;
}
beforeEach(() => {
  dom = new Window();
  stubGlobal("document", dom.document);
  stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  layoutAction = undefined;
  denied = true;
  calls = 0;
  warnings.length = 0;
  originalWarn = console.warn;
  console.warn = (...args) => warnings.push(args);
  originalEnvironment = process.env.NODE_ENV;
  process.env.NODE_ENV = "development";
  source = {} as MediaStream;
  video = dom.document.createElement("video") as unknown as HTMLVideoElement;
  Object.defineProperty(video, "srcObject", { value: source, writable: true, configurable: true });
  Object.defineProperty(video, "paused", { value: true, writable: true, configurable: true });
  video.play = () => {
    calls++;
    if (denied)
      return Promise.reject(
        Object.assign(new Error("Permission denied"), { name: "NotAllowedError" }),
      );
    Object.defineProperty(video, "paused", { value: false, configurable: true });
    video.dispatchEvent(new dom.Event("playing") as never);
    return Promise.resolve();
  };
});
afterEach(async () => {
  await act(async () => renderer?.unmount());
  renderer = undefined;
  await dom.happyDOM.close();
  restoreGlobals();
  console.warn = originalWarn;
  if (originalEnvironment === undefined) delete process.env.NODE_ENV;
  else process.env.NODE_ENV = originalEnvironment;
});
test("client recovery before first frame calls play synchronously and keeps the source", async () => {
  await act(async () => {
    renderer = create(<Probe />);
  });
  expect(latest?.state).toBe("blocked");
  expect(latest?.error).toBe("Permission denied");
  denied = false;
  const before = calls;
  await act(async () => {
    const result = latest!.resume();
    expect(calls).toBe(before + 1);
    expect(video.srcObject).toBe(source);
    await result;
  });
  expect(latest?.state).toBe("playing");
  expect(latest?.error).toBeNull();
  await act(async () => {
    video.dispatchEvent(new dom.Event("pause") as never);
  });
  expect(latest?.state).toBe("playing");
  Object.defineProperty(video, "paused", { value: true, configurable: true });
  await act(async () => {
    video.dispatchEvent(new dom.Event("pause") as never);
  });
  expect(latest?.state).toBe("blocked");
});
test("late promises cannot alter a replaced source or disposed observer", async () => {
  const pending: Array<(e: Error) => void> = [];
  video.play = () => new Promise<void>((_resolve, reject) => pending.push(reject));
  const changes: string[] = [];
  const observer = observeVideoPlayback(video, (snapshot) => changes.push(snapshot.state));
  video.srcObject = {} as MediaStream;
  pending[0]!(new Error("old failure"));
  await Promise.resolve();
  expect(changes).toEqual(["starting"]);
  await observer.resume();
  expect(changes).toEqual(["starting"]);
  observer.dispose();
  const current = observeVideoPlayback(video, (snapshot) => changes.push(snapshot.state));
  const promise = current.resume();
  current.dispose();
  pending[1]!(new Error("retired startup"));
  pending[2]!(new Error("retired failure"));
  await promise;
  expect(changes).toEqual(["starting", "starting", "starting"]);
});
test("rejected retries remain recoverable and synchronous browser failures are reported", async () => {
  await act(async () => {
    renderer = create(<Probe />);
  });
  await act(async () => {
    await latest!.resume();
  });
  expect(latest?.state).toBe("blocked");
  video.play = () => {
    throw new Error("Decoder unavailable");
  };
  await act(async () => {
    await latest!.resume();
  });
  expect(latest?.state).toBe("error");
  expect(latest?.error).toBe("Decoder unavailable");
});
test("development warning requires a missing consumer; unsupported transports expose nothing", async () => {
  await act(async () => {
    renderer = create(<Probe />);
  });
  await new Promise((resolve) => setTimeout(resolve, 10));
  expect(warnings).toHaveLength(0);
  await act(async () => renderer!.update(<Probe consumer={false} />));
  await act(async () => {
    await latest!.resume();
  });
  await new Promise((resolve) => setTimeout(resolve, 10));
  expect(
    warnings.filter((args) => String(args[0]).includes("WebRTC playback needs recovery")),
  ).toHaveLength(1);
  await act(async () => renderer!.update(<Probe enabled={false} />));
  expect(latest).toBeUndefined();
});

// A DOM source handoff can happen before React commits the new adapter snapshot.
test("a captured resume cannot start a replacement source before the next render", async () => {
  await act(async () => {
    renderer = create(<Probe />);
  });
  const resume = latest!.resume;
  const before = calls;
  source = {} as MediaStream;
  video.srcObject = source;
  await resume();
  expect(calls).toBe(before);
  await act(async () => renderer!.update(<Probe />));
  expect(calls).toBeGreaterThan(before);
  expect(latest!.state).toBe("blocked");
});

test("a resume captured before replacement cannot replay the old video during layout", async () => {
  await act(async () => {
    renderer = create(<Probe />);
  });
  const previous = video;
  let previousCalls = 0;
  previous.play = () => {
    previousCalls++;
    return Promise.resolve();
  };
  const resume = latest!.resume;
  video = dom.document.createElement("video") as unknown as HTMLVideoElement;
  Object.defineProperty(video, "srcObject", { value: source, configurable: true });
  video.play = () => Promise.reject(Object.assign(new Error(), { name: "NotAllowedError" }));
  layoutAction = () => {
    void resume();
  };
  await act(async () => renderer!.update(<Probe />));
  expect(previousCalls).toBe(0);
});
