import { describe, expect, test } from "bun:test";

import { CaptureEnableError } from "../../capture/runtime";
import { createCaptureStarter } from "../../capture/start";
import type { CaptureMeta } from "../../capture/store";

const UDID = "ABCD1234-0000-0000-0000-0000000000EF";

/** A runtime whose reported attachment the test sets by hand, the way a lost proxy would. */
function fakeRuntime(initial: CaptureMeta["attachment"] = "not-enabled") {
  let attachment = initial;
  return {
    metaFor: () => ({ attachment }) as CaptureMeta,
    set(next: CaptureMeta["attachment"]) {
      attachment = next;
    },
  };
}

function failing(reason: string) {
  return new CaptureEnableError({ attachment: "failed", attachError: reason } as CaptureMeta);
}

describe("createCaptureStarter", () => {
  test("does not repeat a start that failed in this process", async () => {
    const runtime = fakeRuntime();
    const start = createCaptureStarter(runtime);
    let enables = 0;
    const failures: string[] = [];
    const deps = () => ({
      enable: async () => {
        enables++;
        throw failing("mitmproxy is not installed");
      },
      onFailed: (reason: string) => void failures.push(reason),
    });

    await start([UDID], deps);
    // The failed attempt left failed meta behind, as the runtime does.
    runtime.set("failed");
    await start([UDID], deps);

    expect(enables).toBe(1);
    expect(failures).toEqual(["mitmproxy is not installed"]);
  });

  test("stays latched even when the device later reads as not enabled", async () => {
    const runtime = fakeRuntime();
    const start = createCaptureStarter(runtime);
    let enables = 0;
    const deps = () => ({
      enable: async () => {
        enables++;
        throw failing("simctl refused");
      },
    });

    await start([UDID], deps);
    runtime.set("not-enabled");
    await start([UDID], deps);

    expect(enables).toBe(1);
  });

  test("replaces a session that started and then lost its proxy", async () => {
    const runtime = fakeRuntime();
    const start = createCaptureStarter(runtime);
    let enables = 0;
    const deps = () => ({
      enable: async () => {
        enables++;
        runtime.set("capturing");
        return { proxyAddress: "127.0.0.1:9123" };
      },
    });

    await start([UDID], deps);
    // The proxy died between the two startup calls: failed meta, but no failed start here.
    runtime.set("failed");
    await start([UDID], deps);

    expect(enables).toBe(2);
  });

  test("leaves a device that is capturing alone", async () => {
    const runtime = fakeRuntime("capturing");
    const start = createCaptureStarter(runtime);
    let enables = 0;

    await start([UDID], () => ({ enable: async () => { enables++; return { proxyAddress: "x" }; } }));

    expect(enables).toBe(0);
  });

  test("latches per device, so one failure does not skip another device", async () => {
    const OTHER = "ABCD1234-0000-0000-0000-00000000FFFF";
    const runtime = fakeRuntime();
    const start = createCaptureStarter(runtime);
    const enabled: string[] = [];
    const deps = (udid: string) => ({
      enable: async () => {
        enabled.push(udid);
        if (udid === UDID) throw failing("no library");
        return { proxyAddress: "127.0.0.1:9123" };
      },
    });

    await start([UDID, OTHER], deps);
    await start([UDID, OTHER], deps);

    expect(enabled).toEqual([UDID, OTHER, OTHER]);
  });
});
