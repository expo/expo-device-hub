import { afterAll, expect, mock, test } from "bun:test";
import { EventEmitter } from "node:events";
import * as native from "../../native";
import * as ui from "../../ui-settings";
import { UDID, useTempStateDir } from "../helpers";
import type { NativeDeviceStateSnapshot } from "../../native";
let observed: ((snapshot: NativeDeviceStateSnapshot) => void) | undefined;
let eligibility = { hingeAngle: 0, physicalOrientation: "portrait" };
let eligibilityGate: Promise<void> | undefined;
mock.module("../../native", () => ({ ...native, NativeCapture: class {
  async start() {} async stop() {}
  async screenSize() { return {width:2007,height:2853,screenId:3,orientation:"portrait"}; }
  async subscribeScreenChanges() { return async () => {}; }
  async subscribeDeviceState(callback: typeof observed) { observed=callback; return async()=>{}; }
}, NativeHid: class {
  inputUnavailable=false;
  async setScreen() {} async supportsHingeAngle(){return true;} async supportsPhysicalOrientation(){return true;}
  async hingeState(){return {hingeAngle:0,physicalOrientation:"portrait",tableMode:false};}
  async hingeControlEligibility(){await eligibilityGate;return eligibility;}
  async setHingeAngle(angle:number){eligibility={...eligibility,hingeAngle:angle};return true;}
  async setTableMode(){return true;}
  async key() {} async close() {}
} }));
mock.module("../../ui-settings",()=>({...ui,refreshDeviceOptionState:async()=>{}}));
const temp=useTempStateDir();
const {getDeviceSession,closeDeviceSession}=await import("../../device-session");
const session=getDeviceSession(UDID);
await session.start();
class Socket extends EventEmitter {
  readyState=1;OPEN=1;frames:Buffer[]=[];
  send(value:Buffer){this.frames.push(Buffer.from(value));}
  close(){this.readyState=3;this.emit("close");}
  async reply(tag:number){for(let i=0;i<100;i++){const n=this.frames.findIndex(f=>f[0]===tag);if(n>=0)return JSON.parse(this.frames.splice(n,1)[0]!.subarray(1).toString());await Bun.sleep(5);}throw Error("No reply "+tag);}
}
const socket=new Socket();session.attachHidSocket(socket as never);
function send(tag:number,value?:unknown){socket.emit("message",Buffer.concat([Buffer.from([tag]),value===undefined?Buffer.alloc(0):Buffer.from(JSON.stringify(value))]));}
for(let i=0;i<100&&session.screenConfig().supportsHingeAngle!==true;i++)await Bun.sleep(5);
afterAll(()=>{socket.close();closeDeviceSession(UDID);temp.restore();});
let revision=0;
function sample(angle:number,active=false){observed?.({generation:1,revision:++revision,state:{hingeAngle:angle,physicalOrientation:"portrait",tableMode:active}});}
test("readback orders acknowledgements and fresh external eligibility without trusting stale motion",async()=>{
  sample(0); send(0x0f,{angle:90});expect(await socket.reply(0x8f)).toMatchObject({ok:true,angle:90});
  send(0x13);expect((await socket.reply(0x93)).state).toMatchObject({hingeAngle:90,physicalOrientation:"portrait"});
  eligibility={hingeAngle:180,physicalOrientation:"portrait"};sample(180);
  send(0x13);expect((await socket.reply(0x93)).state).toMatchObject({hingeAngle:180});
});
test("Table Mode setting stays distinct from observed tabletop activity",async()=>{
  send(0x10,{requestId:1,command:{control:"table",value:true}});expect(await socket.reply(0x90)).toMatchObject({ok:true});
  sample(180,false);send(0x13);expect((await socket.reply(0x93)).state).toMatchObject({tableMode:true,tableModeActive:false});
});
test("a readback holds its place before a later hinge command",async()=>{
  let release!:()=>void;eligibilityGate=new Promise<void>(resolve=>{release=resolve;});
  send(0x13);await Bun.sleep(10);send(0x0f,{angle:30});await Bun.sleep(10);
  expect(eligibility.hingeAngle).toBe(180);release();eligibilityGate=undefined;
  expect((await socket.reply(0x93)).state).toMatchObject({hingeAngle:180});
  expect(await socket.reply(0x8f)).toMatchObject({ok:true,angle:30});
});
