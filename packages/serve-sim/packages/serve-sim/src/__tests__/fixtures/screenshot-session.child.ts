import { afterAll, expect, mock, test } from "bun:test";
import * as native from "../../native";
import * as ui from "../../ui-settings";
import { UDID, useTempStateDir } from "../helpers";
let starts=0,stops=0,fail=false;
mock.module("../../native",()=>({...native,NativeCapture:class {
  async start(){starts++;if(fail)throw Error("Startup failed");} async stop(){stops++;}
  async screenSize(){return {width:2007,height:2853,screenId:3,orientation:"portrait"};}
  async activeScreenId(){return 3;}
  async subscribeScreenChanges(){return async()=>{};} async subscribeDeviceState(){return async()=>{};}
},NativeHid:class {async setScreen(){} async supportsHingeAngle(){return false;} async supportsPhysicalOrientation(){return false;} async key(){} async close(){}}}));
mock.module("../../ui-settings",()=>({...ui,refreshDeviceOptionState:async()=>{}}));
const temp=useTempStateDir();
const {getDeviceSession,peekDeviceSession,closeDeviceSession,withScreenshotDeviceSession}=await import("../../device-session");
afterAll(()=>{closeDeviceSession(UDID);temp.restore();});
async function stopped(count:number){for(let i=0;i<100&&stops<count;i++)await Bun.sleep(5);expect(stops).toBe(count);}
test("a one-shot capture closes its temporary session on success and failure",async()=>{
  expect(await withScreenshotDeviceSession(UDID,undefined,s=>s.activeScreenId())).toBe(3);
  expect(peekDeviceSession(UDID)).toBeUndefined();await stopped(1);
  await expect(withScreenshotDeviceSession(UDID,undefined,async()=>{throw Error("Capture failed");})).rejects.toThrow("Capture failed");await stopped(2);
  fail=true;await expect(withScreenshotDeviceSession(UDID,undefined,s=>s.activeScreenId())).rejects.toThrow("Startup failed");fail=false;await stopped(3);
});
test("a screenshot borrows an existing session without closing or replacing it",async()=>{
  const existing=getDeviceSession(UDID);await existing.start();const before=starts;
  expect(await withScreenshotDeviceSession(UDID,undefined,s=>s.activeScreenId())).toBe(3);
  expect(peekDeviceSession(UDID)).toBe(existing);expect(starts).toBe(before);expect(stops).toBe(3);
  closeDeviceSession(UDID);await stopped(4);
});

test("overlapping screenshots share startup and a newly joined stream retains capture",async()=>{
  let entered!:()=>void,release!:()=>void;
  const ready=new Promise<void>(r=>{entered=r;}),gate=new Promise<void>(r=>{release=r;});
  const before=starts,beforeStops=stops;
  const first=withScreenshotDeviceSession(UDID,undefined,async()=>{entered();await gate;});
  await ready;
  const shared=peekDeviceSession(UDID)!;
  expect(await withScreenshotDeviceSession(UDID,undefined,s=>s.activeScreenId())).toBe(3);
  expect(starts).toBe(before+1);expect(stops).toBe(beforeStops);
  expect(getDeviceSession(UDID)).toBe(shared);release();await first;
  expect(peekDeviceSession(UDID)).toBe(shared);expect(stops).toBe(beforeStops);
  closeDeviceSession(UDID);await stopped(beforeStops+1);
});
