import { afterEach, expect, test } from "bun:test";
import { Window } from "happy-dom";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";

import { DeviceScreen } from "../DeviceScreen";
import type { ScreenSize } from "../types";
import { NOOP_DEVICE_CLIENT } from "../useNoopDeviceClient";
import { createGlobalStubs } from "./test-globals";

const { stubGlobal, restoreGlobals } = createGlobalStubs();
let root: Root | undefined;
let dom: Window | undefined;

afterEach(async () => {
  if (root) await act(async () => root?.unmount());
  await dom?.happyDOM.close();
  root = undefined;
  dom = undefined;
  restoreGlobals();
});

async function mediaTransform(screen: ScreenSize): Promise<string> {
  dom = new Window();
  stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  stubGlobal("window", dom);
  stubGlobal("document", dom.document);
  const element = dom.document.createElement("div");
  dom.document.body.append(element);
  root = createRoot(element as unknown as HTMLDivElement);
  await act(async () =>
    root!.render(<DeviceScreen client={{ ...NOOP_DEVICE_CLIENT, status: "streaming", screen }} />),
  );
  const media = element.querySelector("img") as unknown as HTMLImageElement;
  return media.style.transform;
}

test("DeviceScreen turns raw serve-sim frames but shows upright serve-emu frames as they are", async () => {
  const upsideDown = { width: 1080, height: 2400, orientation: "portrait_upside_down" } as const;
  expect(await mediaTransform(upsideDown)).toContain("rotate(180deg)");
  await act(async () => root?.unmount());
  root = undefined;
  restoreGlobals();
  expect(await mediaTransform({ ...upsideDown, framesUpright: true })).toBe("");
});
