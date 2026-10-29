import { beforeEach, describe, expect, mock, test } from "bun:test";

import { appleCornerRadii, clearCornerRadiiCache } from "../corner-radii";

const radii = { topLeft: 0.1, topRight: 0.1, bottomRight: 0.1, bottomLeft: 0.1 };
const failure = { value: null, error: new Error("plutil timed out") };

beforeEach(clearCornerRadiiCache);

describe("appleCornerRadii", () => {
  test("reads each device type once", async () => {
    const read = mock(async () => ({ value: radii }));

    expect(await appleCornerRadii("type-a", read)).toEqual(radii);
    expect(await appleCornerRadii("type-a", read)).toEqual(radii);
    expect(read).toHaveBeenCalledTimes(1);
  });

  test("skips devices without a device type", async () => {
    const read = mock(async () => ({ value: radii }));

    expect(await appleCornerRadii(null, read)).toBeNull();
    expect(read).not.toHaveBeenCalled();
  });

  test("keeps a model with no profile for good", async () => {
    const read = mock(async () => ({ value: null }));

    expect(await appleCornerRadii("watch", read, 0)).toBeNull();
    expect(await appleCornerRadii("watch", read, 3_600_000)).toBeNull();
    expect(read).toHaveBeenCalledTimes(1);
  });

  test("shares one read between overlapping refreshes", async () => {
    let finish: (value: { value: typeof radii }) => void = () => {};
    const read = mock(() => new Promise<{ value: typeof radii }>((resolve) => (finish = resolve)));

    const first = appleCornerRadii("type-a", read, 0);
    const second = appleCornerRadii("type-a", read, 100);
    finish({ value: radii });

    expect(await first).toEqual(radii);
    expect(await second).toEqual(radii);
    expect(read).toHaveBeenCalledTimes(1);
  });

  describe("a failed read", () => {
    test("is not remembered for good: the next refresh after the delay asks again", async () => {
      const read = mock(async () => failure);

      expect(await appleCornerRadii("ipad", read, 0)).toBeNull();
      await appleCornerRadii("ipad", read, 5_000);
      expect(read).toHaveBeenCalledTimes(1);

      await appleCornerRadii("ipad", read, 10_000);
      expect(read).toHaveBeenCalledTimes(2);
    });

    test("recovers once the profile can be read", async () => {
      const read = mock<() => Promise<{ value: typeof radii | null; error?: unknown }>>(
        async () => failure,
      );

      expect(await appleCornerRadii("ipad", read, 0)).toBeNull();
      read.mockImplementation(async () => ({ value: radii }));

      expect(await appleCornerRadii("ipad", read, 10_000)).toEqual(radii);
      // The success is kept like any other.
      await appleCornerRadii("ipad", read, 3_600_000);
      expect(read).toHaveBeenCalledTimes(2);
    });

    test("includes a reader that throws", async () => {
      const read = mock(async () => {
        throw new Error("spawn plutil ENOENT");
      });

      expect(await appleCornerRadii("ipad", read, 0)).toBeNull();
      await appleCornerRadii("ipad", read, 10_000);
      expect(read).toHaveBeenCalledTimes(2);
    });
  });
});
