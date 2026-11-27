import { expect, spyOn, test } from "bun:test";
import * as capabilitySessions from "../capability-session";
import { simMiddleware } from "../middleware";
import { useTempStateDir } from "./helpers";

test("middleware disposal preserves both capability failures in release order", async () => {
  const state = useTempStateDir();
  const calls: string[] = [];
  const failures = {
    clipboard: new Error("clipboard cleanup"),
    keychain: new Error("keychain cleanup"),
  };
  const originalCreate = capabilitySessions.createCapabilitySession;
  const create = spyOn(capabilitySessions, "createCapabilitySession").mockImplementation(
    (definition) => ({
      ...originalCreate(definition, false),
      dispose: async () => {
        calls.push(definition.name);
        throw failures[definition.name as keyof typeof failures];
      },
    }),
  );
  try {
    let failure: unknown;
    try {
      await simMiddleware().dispose();
    } catch (error) {
      failure = error;
    }
    expect(calls).toEqual(["clipboard", "keychain"]);
    expect(failure).toBeInstanceOf(AggregateError);
    expect((failure as AggregateError).errors).toEqual([failures.clipboard, failures.keychain]);
  } finally {
    create.mockRestore();
    state.restore();
  }
});
