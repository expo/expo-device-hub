import { expect, test } from "bun:test";
import { getNetworkStatus } from "../src/adb.ts";
import type { execText } from "../src/exec.ts";

type Deferred<T> = {
  promise: Promise<T>;
  resolve(value: T): void;
};

function deferred<T>(): Deferred<T> {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

test("getNetworkStatus reads Wi-Fi and mobile settings concurrently", async () => {
  const wifi = deferred<string>();
  const mobile = deferred<string>();
  const calls: string[] = [];
  const runExec = (async (_cmd, args) => {
    const setting = args.at(-1)!;
    calls.push(setting);
    const stdout = await (setting === "wifi_on"
      ? wifi.promise
      : mobile.promise);
    return {
      status: 0,
      signal: null,
      stdout,
      stderr: "",
      timedOut: false,
      error: null,
    };
  }) as typeof execText;

  const status = getNetworkStatus("emulator-5554", runExec);
  await Promise.resolve();
  expect(calls).toEqual(["wifi_on", "mobile_data"]);

  mobile.resolve("0\n");
  wifi.resolve("1\n");
  expect(await status).toEqual({
    enabled: true,
    wifi: "enabled",
    mobileData: "disabled",
    raw: { wifi: "1", mobileData: "0" },
  });
});
