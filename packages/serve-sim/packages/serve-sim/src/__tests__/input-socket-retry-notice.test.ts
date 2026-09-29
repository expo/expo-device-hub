import { expect, test } from "bun:test";
import { createInputSocketRetryNotice } from "../client/utils/input-socket-retry-notice";

test("repeated 1013 closes stay quiet when a retry is admitted", async () => {
  const errors: string[] = [];
  const notice = createInputSocketRetryNotice((reason) => errors.push(reason), 30);
  try {
    notice.connecting();
    notice.rejected("busy");
    notice.connecting();
    notice.rejected("busy");
    notice.admitted();
    await Bun.sleep(60);
    expect(errors).toEqual([]);
  } finally {
    notice.dispose();
  }
});

test("persistent 1013 closes report once after the retry window", async () => {
  const errors: string[] = [];
  const notice = createInputSocketRetryNotice((reason) => errors.push(reason), 30);
  try {
    notice.connecting();
    notice.rejected("busy");
    notice.connecting();
    notice.rejected("busy");
    await Bun.sleep(60);
    notice.connecting();
    notice.rejected("busy");
    await Bun.sleep(60);
    expect(errors).toEqual(["busy"]);
  } finally {
    notice.dispose();
  }
});
