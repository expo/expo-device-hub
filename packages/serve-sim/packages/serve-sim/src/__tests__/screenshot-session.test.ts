import { expect, test } from "bun:test";
import { runChildSuite } from "./fixtures/run-child-suite";
test("one-shot screenshots release temporary capture and preserve shared sessions",async()=>{
  const result=await runChildSuite("screenshot-session.child.ts");expect(result.exitCode,result.output).toBe(0);
});
