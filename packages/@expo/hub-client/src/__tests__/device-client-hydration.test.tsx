import { afterEach, expect, test } from "bun:test";
import { Window } from "happy-dom";
import { act, useLayoutEffect } from "react";
import { hydrateRoot, type Root } from "react-dom/client";
import { renderToString } from "react-dom/server";

import { DeviceClientProvider } from "../DeviceClientProvider";
import { useDeviceClient } from "../useDeviceClient";
import { useDeviceScreenClient } from "../useDeviceScreenClient";
import { createGlobalStubs } from "./test-globals";

const { stubGlobal, restoreGlobals } = createGlobalStubs();
let root: Root | undefined;
let browser: Window | undefined;

afterEach(async () => {
  if (root) await act(async () => root?.unmount());
  root = undefined;
  await browser?.happyDOM.abort();
  browser?.close();
  browser = undefined;
  restoreGlobals();
});

for (const platform of ["ios", "android"] as const) {
  test(`${platform} hydrates without changing the server snapshot when WebCodecs becomes available`, async () => {
    const reads: string[] = [];
    const mounted: string[] = [];
    function Screen() {
      const { platform } = useDeviceClient();
      const { videoKind, attachVideo } = useDeviceScreenClient();
      reads.push(`${platform}/${videoKind}`);
      useLayoutEffect(() => {
        mounted.push(platform);
      }, [platform]);
      return (
        <div data-platform={platform}>
          {videoKind === "canvas" ? (
            <canvas ref={attachVideo} />
          ) : (
            <img ref={attachVideo} alt="Device" />
          )}
        </div>
      );
    }
    const tree = (
      <DeviceClientProvider
        platform={platform}
        options={{ baseUrl: "", streamMode: "h264", enabled: false }}
      >
        <Screen />
      </DeviceClientProvider>
    );
    stubGlobal("VideoDecoder", undefined);
    const html = renderToString(tree);
    expect(reads).toEqual([`${platform}/${platform === "android" ? "canvas" : "img"}`]);
    reads.length = 0;
    browser = new Window({ url: "https://hub.test/" });
    stubGlobal("window", browser);
    stubGlobal("document", browser.document);
    stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
    Reflect.set(globalThis, "VideoDecoder", class {});
    const container = browser.document.createElement("div");
    container.innerHTML = html;
    browser.document.body.append(container);
    const errors: unknown[] = [];
    await act(async () => {
      root = hydrateRoot(container as unknown as HTMLElement, tree, {
        onRecoverableError: (error) => errors.push(error),
      });
    });
    expect(errors).toEqual([]);
    expect(reads[0]).toBe(`${platform}/${platform === "android" ? "canvas" : "img"}`);
    expect(mounted).toEqual([platform]);
    expect(container.querySelector("canvas")).not.toBeNull();
    expect(container.querySelector("img")).toBeNull();
  });
}
