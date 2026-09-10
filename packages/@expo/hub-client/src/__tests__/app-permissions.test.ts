import { describe, expect, test } from "bun:test";
import {
  applyPermissionsRead,
  humanize,
  readPermissions,
  heldPermissionIds,
} from "../app-permissions";
import { type AppPermission } from "../types";

const row = (id: string, state: AppPermission["state"]): AppPermission => ({
  id,
  label: id,
  state,
});

describe("humanize", () => {
  test("turns backend names into sentence case", () => {
    expect(humanize("ACCESS_FINE_LOCATION")).toBe("Access fine location");
    expect(humanize("photos-add")).toBe("Photos add");
    expect(humanize("camera")).toBe("Camera");
  });
});

describe("heldPermissionIds", () => {
  test("holds pending ids and ids written during the request, except its own", () => {
    const held = heldPermissionIds(new Set(["a", "own"]), { b: 1 }, { b: 2, c: 1 }, ["own"]);
    expect([...held].sort()).toEqual(["a", "b", "c"]);
  });
});

describe("applyPermissionsRead", () => {
  test("keeps the current row for held ids and takes the rest from the read", () => {
    const current = [row("a", "granted"), row("b", "denied")];
    const next = [row("a", "denied"), row("b", "granted"), row("c", "granted")];
    expect(applyPermissionsRead(current, next, new Set(["a"]))).toEqual([
      row("a", "granted"),
      row("b", "granted"),
      row("c", "granted"),
    ]);
    expect(applyPermissionsRead(null, next, new Set(["a"]))).toBe(next);
  });
});

describe("readPermissions", () => {
  test("surfaces the backend error text on failure", async () => {
    const response = new Response(JSON.stringify({ ok: false, error: "packageName is invalid" }), {
      status: 400,
    });
    await expect(readPermissions(response, () => [], "fallback")).rejects.toThrow(
      "packageName is invalid",
    );
    const broken = new Response("not json", { status: 200 });
    await expect(readPermissions(broken, () => null, "fallback")).rejects.toThrow("fallback");
  });
});
