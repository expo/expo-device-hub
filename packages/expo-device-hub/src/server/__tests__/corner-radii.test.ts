import { beforeEach, describe, expect, mock, test } from "bun:test";

import { androidCornerRadii, appleCornerRadii, clearCornerRadiiCache } from "../corner-radii";

const radii = { topLeft: 0.1, topRight: 0.1, bottomRight: 0.1, bottomLeft: 0.1 };

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
});
