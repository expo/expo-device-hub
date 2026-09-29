import { expect, test } from "bun:test";
import { resolve } from "node:path";
import { proxyDylibCandidates } from "../device";

test("proxyDylibCandidates includes the checkout's native build", () => {
  expect(proxyDylibCandidates()).toContain(resolve(import.meta.dir, "../../../dist/simnet/libSimNetProxy.dylib"));
});
