import { afterEach, expect, test } from "bun:test";
import { act, create, type ReactTestRenderer } from "react-test-renderer";

import {
  type FoldFetch,
  ANDROID_FOLD_CAPABILITIES,
  parseAndroidFold,
  requestAndroidFold,
} from "../android-fold";
import { useAndroidFold } from "../useAndroidFold";
import { createGlobalStubs } from "./test-globals";

const { stubGlobal, restoreGlobals } = createGlobalStubs();
let renderer: ReactTestRenderer | undefined;
afterEach(async () => {
  if (renderer) await act(async () => renderer?.unmount());
  renderer = undefined;
  restoreGlobals();
});
const payload = (
  posture: string | null = "opened",
  hingeAngle: number | null = 180,
  supported = true,
) => ({ ok: true, fold: { supported, posture, hingeAngle } });

test("validates all read-only postures and unsupported devices", () => {
  for (const posture of ["closed", "opened", "half_opened", "flipped", "tent", null] as const) {
    expect(parseAndroidFold(payload(posture))?.posture).toBe(posture);
  }
  expect(parseAndroidFold(payload(null, null, false))?.supported).toBe(false);
  for (const value of [
    undefined,
    {},
    { ok: false },
    payload("constructor"),
    payload("sideways"),
    { ok: true, fold: { supported: true, posture: null } },
    payload(null, NaN),
  ]) {
    expect(parseAndroidFold(value)).toBeNull();
  }
});

test("reports HTTP and malformed response failures", async () => {
  const fetchImpl = (async () =>
    Response.json({ ok: false, error: "No hinge" }, { status: 400 })) as FoldFetch;
  await expect(
    requestAndroidFold(fetchImpl, "https://hub.test/api/fold", "closed"),
  ).rejects.toThrow("No hinge");
});

async function mount() {
  stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  const polls = new Set<() => void>();
  stubGlobal("setInterval", (callback: () => void) => {
    polls.add(callback);
    return callback;
  });
  stubGlobal("clearInterval", (callback: () => void) => {
    polls.delete(callback);
  });
  let status = payload();
  const writes: Array<{ url: string; posture: string; finish: () => void }> = [];
  let holdRead = false;
  const reads: Array<() => void> = [];
  let failWrite = false;
  const fetchImpl = (async (input: string, init?: RequestInit) => {
    if (init?.method === "POST") {
      const posture = JSON.parse(init.body as string).posture as string;
      await new Promise<void>((resolve) => writes.push({ url: input, posture, finish: resolve }));
      if (failWrite) return Response.json({ ok: false, error: "Fold failed" }, { status: 500 });
      return Response.json(payload(posture, posture === "closed" ? 0 : 180));
    }
    const answer = status;
    if (holdRead) await new Promise<void>((resolve) => reads.push(resolve));
    return Response.json(answer);
  }) as FoldFetch;
  // A separate function represents a refreshed token while preserving the device URL.
  const nextFetch = ((...args: Parameters<FoldFetch>) => fetchImpl(...args)) as FoldFetch;
  let result!: ReturnType<typeof useAndroidFold>;
  function Harness({
    url = "https://hub.test/api/fold?device=one",
    token = false,
    locked = false,
  }: {
    url?: string | null;
    token?: boolean;
    locked?: boolean;
  }) {
    result = useAndroidFold(url, token ? nextFetch : fetchImpl, locked);
    return null;
  }
  await act(async () => {
    renderer = create(<Harness />);
  });
  return {
    result: () => result,
    writes,
    reads,
    status: (next: typeof status) => {
      status = next;
    },
    holdRead: (hold: boolean) => {
      holdRead = hold;
    },
    failWrite: () => {
      failWrite = true;
    },
    poll: () =>
      act(async () => {
        for (const poll of polls) poll();
      }),
    finish: (index: number) =>
      act(async () => {
        writes[index]!.finish();
      }),
    update: (props: Parameters<typeof Harness>[0]) =>
      act(async () => {
        renderer?.update(<Harness {...props} />);
      }),
    choose: (value: "closed" | "open") =>
      act(async () => {
        result.fold?.setControl({ control: "pose", value });
      }),
  };
}

test("offers only closed/open, reads other postures without inventing physical groups, and discovers a hinge later", async () => {
  const h = await mount();
  expect(h.result().foldCapabilities).toEqual(ANDROID_FOLD_CAPABILITIES);
  expect(h.result().fold?.pose).toBe("open");
  expect(h.result().fold?.tableMode).toBeUndefined();
  expect(h.result().fold?.physical).toBeUndefined();
  for (const posture of ["half_opened", "flipped", "tent", null]) {
    h.status(payload(posture, 90));
    await h.poll();
    expect(h.result().fold?.pose).toBeNull();
    expect(h.result().fold?.angle).toBe(90);
  }
  h.status(payload(null, null, false));
  await h.poll();
  expect(h.result().fold).toBeNull();
  expect(h.result().foldCapabilities).toBe(false);
  h.status(payload("closed", 0));
  await h.poll();
  expect(h.result().fold?.pose).toBe("closed");
  await act(async () => h.result().fold?.setControl({ control: "angle", value: 90 }));
  expect(h.result().fold?.error).toContain("not supported");
  expect(h.writes).toHaveLength(0);
});

test("serializes writes and coalesces queued choices with authoritative acknowledgement", async () => {
  const h = await mount();
  await h.choose("closed");
  await h.choose("closed");
  await h.choose("open");
  expect(h.writes.map((w) => w.posture)).toEqual(["closed"]);
  expect(h.result().fold?.pose).toBe("open");
  expect(h.result().fold?.pending).toBe(true);
  await h.finish(0);
  expect(h.writes.map((w) => w.posture)).toEqual(["closed", "opened"]);
  expect(h.result().fold?.pending).toBe(true);
  await h.finish(1);
  expect(h.result().fold?.pending).toBe(false);
  expect(h.result().fold?.pose).toBe("open");
});

test("a poll started before a write cannot overwrite its result", async () => {
  const h = await mount();
  h.holdRead(true);
  await h.poll();
  await h.choose("closed");
  await h.finish(0);
  await act(async () => h.reads[0]!());
  expect(h.result().fold?.pose).toBe("closed");
});

test("ignores retired callbacks and replies after changing devices, tokens or enabled state", async () => {
  const h = await mount();
  const retired = h.result().fold!;
  await h.choose("closed");
  await h.update({ url: "https://hub.test/api/fold?device=two" });
  await h.finish(0);
  expect(h.result().fold?.pose).toBe("open");
  await act(async () => retired.setControl({ control: "pose", value: "closed" }));
  expect(h.writes).toHaveLength(1);
  await h.choose("closed");
  await h.update({ token: true, url: "https://hub.test/api/fold?device=two" });
  await h.finish(1);
  expect(h.result().fold?.pose).toBe("open");
  await h.update({ url: null });
  expect(h.result().fold).toBeNull();
});

test("surfaces write failures and rejects changes while recording is locked", async () => {
  const h = await mount();
  h.failWrite();
  await h.choose("closed");
  await h.finish(0);
  expect(h.result().fold?.pending).toBe(false);
  expect(h.result().fold?.error).toBe("Fold failed");
  await h.update({ locked: true });
  await h.choose("closed");
  expect(h.writes).toHaveLength(1);
  expect(h.result().fold?.error).toContain("recording");
});

test("a queued choice is rejected if recording locks before its turn", async () => {
  const h = await mount();
  await h.choose("closed");
  await h.choose("open");
  await h.update({ locked: true });
  await h.finish(0);
  expect(h.writes).toHaveLength(1);
  expect(h.result().fold?.pending).toBe(false);
  expect(h.result().fold?.error).toContain("recording");
});

test("new token writes to the same device wait for an earlier request", async () => {
  const h = await mount();
  await h.choose("closed");
  await h.update({ token: true });
  await h.choose("open");
  expect(h.writes).toHaveLength(1);
  await h.finish(0);
  expect(h.writes.map((write) => write.posture)).toEqual(["closed", "opened"]);
  await h.finish(1);
  expect(h.result().fold?.pose).toBe("open");
  expect(h.result().fold?.pending).toBe(false);
});
