import { describe, expect, test } from "bun:test";
import { readFileSync, readdirSync, writeFileSync } from "fs";
import { join } from "path";

import { InvalidHostActionError, runHostActionAsync } from "../host-actions";
import { capabilityConfigPath } from "../capability-config";
import { UDID, installShims, useTempStateDir } from "./helpers";
import { readLaunchState, writeLaunchState } from "../launch-state";

describe("app.launch", () => {
  test.each([UDID, UDID.toLowerCase()])("launches with canonical device state, literal arguments and its deep link: %s", async (udid) => {
    const state = useTempStateDir();
    const shims = installShims({
      xcrun: `#!/usr/bin/env node
require('fs').appendFileSync(process.env.SERVE_SIM_LAUNCH_LOG, JSON.stringify(process.argv.slice(2)) + '\\n');
`,
    });
    const originalLog = process.env.SERVE_SIM_LAUNCH_LOG;
    const log = join(shims.dir, "launch.jsonl");
    process.env.SERVE_SIM_LAUNCH_LOG = log;
    writeFileSync(log, "");
    try {
      const result = await runHostActionAsync(
        {
          action: "app.launch",
          params: {
            udid,
            bundleId: "com.example.app",
            launchArgs: ["--flag", "space and $(literal)"],
            openUrl: "example://screen?value=one",
          },
        },
        "true",
      );
      expect(result.exitCode).toBe(0);
      const calls = readFileSync(log, "utf8")
        .trim()
        .split("\n")
        .map((line) => JSON.parse(line));
      expect(calls.filter((args) => ["terminate", "launch"].includes(args[1]))).toEqual([
        ["simctl", "terminate", UDID, "com.example.app"],
        ["simctl", "launch", UDID, "com.example.app", "--flag", "space and $(literal)"],
      ]);
      expect(calls.at(-1)).toEqual(["simctl", "openurl", UDID, "example://screen?value=one"]);
      expect(readLaunchState(UDID)).toMatchObject({
        bundleId: "com.example.app",
        launchArgs: ["--flag", "space and $(literal)"],
      });
      expect(readdirSync(state.dir)).toContain(`launch-${UDID}.json`);
      expect(
        calls.some(
          (args) => args[1] === "spawn" && args.includes("com.apple.launchservices.schemeapproval"),
        ),
      ).toBe(true);
    } finally {
      if (originalLog === undefined) delete process.env.SERVE_SIM_LAUNCH_LOG;
      else process.env.SERVE_SIM_LAUNCH_LOG = originalLog;
      shims.restore();
      state.restore();
    }
  });

  test("rejects an oversized UTF-8 argument vector before changing launch state", async () => {
    const state = useTempStateDir();
    const log = join(state.dir, "commands");
    writeFileSync(log, "");
    const shims = installShims({
      xcrun: `#!/usr/bin/env node
require('fs').appendFileSync(${JSON.stringify(log)}, 'invoked');
`,
    });
    try {
      await expect(
        runHostActionAsync(
          {
            action: "app.launch",
            params: {
              udid: UDID,
              bundleId: "com.example.app",
              launchArgs: Array(16).fill("😃".repeat(4096)),
            },
          },
          "true",
        ),
      ).rejects.toBeInstanceOf(InvalidHostActionError);
      expect(readFileSync(log, "utf8")).toBe("");
      expect(readLaunchState(UDID)).toBeNull();
    } finally {
      shims.restore();
      state.restore();
    }
  });

  test("returns a failed terminate check with its diagnostic instead of hiding it", async () => {
    const state = useTempStateDir();
    const shims = installShims({
      xcrun: "#!/bin/sh\nprintf 'could not reach simulator' >&2\nexit 1\n",
    });
    try {
      const result = await runHostActionAsync(
        { action: "app.launch", params: { udid: UDID, bundleId: "com.example.app" } },
        "true",
      );
      expect(result.exitCode).toBe(1);
      expect(result.stderr).toContain("could not check whether it is still running");
      expect(result.stderr).toContain(UDID);
    } finally {
      shims.restore();
      state.restore();
    }
  });

  test.each([
    { udid: "booted", bundleId: "com.example.app" },
    { udid: UDID, bundleId: "--help" },
    { udid: UDID, bundleId: "com.example.app", launchArgs: ["a\u0000b"] },
    { udid: UDID, bundleId: "com.example.app", openUrl: "--help" },
    { udid: UDID, bundleId: "com.example.app", openUrl: "example:\u0000screen" },
  ])("rejects invalid launch parameters: %j", async (params) => {
    await expect(
      runHostActionAsync({ action: "app.launch", params }, "true"),
    ).rejects.toBeInstanceOf(InvalidHostActionError);
  });
});


test.each(["terminate", "launch"])("a failed %s preserves the previous target and configuration", async (stage) => {
  const state = useTempStateDir();
  const previous = { bundleId: "com.example.previous", launchArgs: ["original"], capabilities: {
    fixture: { name: "fixture", dylib: "/tmp/fixture.dylib", scope: "userApps" as const, ownerPid: null, bundleId: null },
  } };
  writeLaunchState(UDID, previous);
  writeFileSync(capabilityConfigPath(UDID), "original config");
  const environmentFile = join(state.dir, "launchctl-environment.json");
  const environment = {
    DYLD_INSERT_LIBRARIES: "/tmp/external.dylib",
    SERVE_SIM_CAPABILITIES_CONFIG: "/tmp/previous-capabilities.tsv",
  };
  writeFileSync(environmentFile, JSON.stringify({ values: environment }));
  const shims = installShims({ xcrun: `#!/usr/bin/env node
const fs = require('fs');
const args = process.argv.slice(2);
const path = ${JSON.stringify(environmentFile)};
const held = JSON.parse(fs.readFileSync(path, 'utf8'));
if (args[1] === '${stage}') {
  held.atFailure = { ...held.values };
  fs.writeFileSync(path, JSON.stringify(held));
  console.error('fixture failure'); process.exit(1);
}
if (args[1] === 'spawn' && args[3] === 'launchctl') {
  const [operation, name, value] = args.slice(4);
  if (operation === 'getenv') console.log(held.values[name] || '');
  if (operation === 'list') console.log('UIKitApplication:com.example.next');
  if (operation === 'setenv' || operation === 'unsetenv') {
    if (operation === 'setenv') held.values[name] = value;
    else delete held.values[name];
    fs.writeFileSync(path, JSON.stringify(held));
  }
}
` });
  try {
    const result = await runHostActionAsync({ action: "app.launch", params: { udid: UDID, bundleId: "com.example.next" } }, "true");
    expect(result.exitCode).toBe(1);
    expect(readLaunchState(UDID)).toEqual(previous);
    expect(readFileSync(capabilityConfigPath(UDID), "utf8")).toBe("original config");
    const held = JSON.parse(readFileSync(environmentFile, "utf8"));
    expect(held.values).toEqual(environment);
    // Capture the actual simulator values at failure, then check their restored values above.
    expect(held.atFailure.SERVE_SIM_CAPABILITIES_CONFIG).toBe(capabilityConfigPath(UDID));
    expect(held.atFailure.DYLD_INSERT_LIBRARIES).toContain(environment.DYLD_INSERT_LIBRARIES);
    expect(held.atFailure.DYLD_INSERT_LIBRARIES).toContain("libServeSimCapabilityLoader.dylib");
  } finally { shims.restore(); state.restore(); }
});

test("concurrent launch and standalone URLs keep each approval adjacent to delivery", async () => {
  const state = useTempStateDir();
  const log = join(state.dir, "commands");
  writeFileSync(log, "");
  const shims = installShims({ xcrun: `#!/usr/bin/env node
const fs=require('fs');
fs.appendFileSync(${JSON.stringify(log)}, JSON.stringify(process.argv.slice(2))+'\\n');
if(process.argv.includes('defaults')) setTimeout(()=>{},100);
` });
  try {
    const results = await Promise.all([
      runHostActionAsync({action:"app.launch",params:{udid:UDID,bundleId:"com.example.a",openUrl:"shared://a"}}, "true"),
      runHostActionAsync({action:"app.openUrl",params:{udid:UDID.toLowerCase(),bundleId:"com.example.b",url:"shared://b"}}, "true"),
    ]);
    expect(results.map((r)=>r.exitCode)).toEqual([0,0]);
    const calls = readFileSync(log,"utf8").trim().split("\n").map((line)=>JSON.parse(line));
    const links = calls.filter((args)=>args.includes("defaults") || args[1]==="openurl");
    expect(links).toHaveLength(4);
    for (let i=0;i<4;i+=2) {
      const bundle = links[i].at(-1);
      expect(links[i+1]).toEqual(["simctl","openurl",UDID, bundle === "com.example.a" ? "shared://a" : "shared://b"]);
    }
  } finally { shims.restore(); state.restore(); }
});

test("the largest accepted argument vector fits a real macOS child process", async () => {
  const state = useTempStateDir();
  const shims = installShims({ xcrun: "#!/bin/sh\nexit 0\n" });
  try {
    const launchArgs = Array(128).fill("a".repeat(1023));
    expect((await runHostActionAsync({ action:"app.launch", params:{udid:UDID,bundleId:"com.example.app",launchArgs}}, "true")).exitCode).toBe(0);
    await expect(runHostActionAsync({ action:"app.launch", params:{udid:UDID,bundleId:"com.example.app",launchArgs:[...launchArgs,"a"]}}, "true")).rejects.toThrow();
  } finally { shims.restore(); state.restore(); }
});


test("invalid capability setup fails before terminating a running app", async () => {
  const state = useTempStateDir();
  const log = join(state.dir,"preflight-commands");
  writeFileSync(log,"");
  const previous = { bundleId:"com.example.app",launchArgs:["original"],capabilities:{
    fixture:{name:"fixture",dylib:join(state.dir,"missing.dylib"),scope:"userApps" as const,ownerPid:null,bundleId:null,loadPhase:"startup" as const},
  }};
  writeLaunchState(UDID,previous);
  const shims=installShims({xcrun:`#!/usr/bin/env node
require('fs').appendFileSync(${JSON.stringify(log)},JSON.stringify(process.argv.slice(2))+'\\n');
`});
  try {
    const result=await runHostActionAsync({action:"app.launch",params:{udid:UDID,bundleId:"com.example.app"}},"true");
    expect(result.exitCode).toBe(1);
    expect(readFileSync(log,"utf8")).not.toContain('"terminate"');
    expect(readFileSync(log,"utf8")).not.toContain('"launch"');
    expect(readLaunchState(UDID)).toEqual(previous);
  } finally {shims.restore();state.restore();}
});
