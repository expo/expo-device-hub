import { afterEach, expect, mock, test } from "bun:test";
import { EventEmitter } from "node:events";
import * as native from "../../native";
import * as ui from "../../ui-settings";
import * as ax from "../../ax";
import * as copy from "../../sim-pasteboard-copy";
import { readSavedHingeState, writeSavedHingeState } from "../../hinge-saved-state";

const handles: Hid[] = [];
let gate: Promise<void> | undefined;
let entered: () => void = () => {};
let suspended = 0;
let keyboardVisible = true;
let keyboardProbe: Promise<boolean> | undefined;
let keyboardGate: Promise<void> | undefined;
let hingeReadGate: Promise<void> | undefined;
let supportReadGate: Promise<void> | undefined;
let nativeHingeAngle = 180;
let unknownHingeState = false;
let nativePhysicalOrientation: string | undefined;
let copyTurnGate: Promise<void> | undefined;
let copyEntered = () => {};
let copyTurns = 0;
class Hid {
  screens: number[] = [];
  angles: number[] = [];
  rotations: number[] = [];
  keyboardToggles = 0;
  keys: string[] = [];
  async keyChecked(type: string, usage: number) {
    this.keys.push(`${type}:${usage}`);
  }
  constructor() {
    handles.push(this);
  }
  async setScreen(id: number) {
    this.screens.push(id);
  }
  async supportsHingeAngle() {
    return true;
  }
  async supportsPhysicalOrientation() {
    if (supportReadGate) {
      entered();
      await supportReadGate;
    }
    return true;
  }
  async hingeState() {
    if (unknownHingeState) return {};
    if (hingeReadGate) {
      entered();
      await hingeReadGate;
    }
    return {
      hingeAngle: nativeHingeAngle,
      tableMode: false,
      physicalOrientation: nativePhysicalOrientation,
    };
  }
  async setHingeAngle(angle: number) {
    this.angles.push(angle);
    nativeHingeAngle = angle;
    if (gate) {
      entered();
      await gate;
    }
    return true;
  }
  async setHingePose() {
    nativeHingeAngle = 90;
    nativePhysicalOrientation = "portrait";
    return true;
  }
  async setTableMode() {
    return true;
  }
  async orientation(value: number) {
    this.rotations.push(value);
    nativePhysicalOrientation = "landscape-left";
    if (gate) {
      entered();
      await gate;
    }
    return true;
  }
  async softwareKeyboard() {
    this.keyboardToggles++;
    keyboardVisible = !keyboardVisible;
    if (keyboardGate) {
      entered();
      await keyboardGate;
    }
  }
  async button() {
    await this.nativeControl();
  }
  async buttonHid() {
    await this.nativeControl();
  }
  async caDebug() {
    await this.nativeControl();
  }
  async memoryWarning() {
    await this.nativeControl();
  }
  async digitalCrown() {
    await this.nativeControl();
  }
  private async nativeControl() {
    if (keyboardGate) {
      entered();
      await keyboardGate;
    }
  }
}
class Capture {
  async start() {}
  async stop() {}
  async suspendForReboot() {
    suspended++;
  }
  async resumeAfterReboot() {}
  async subscribeScreenChanges() {
    return async () => {};
  }
  async subscribeDeviceState() {
    return async () => {};
  }
  async screenSize() {
    return { width: 2006, height: 2852, screenId: 3, orientation: "portrait" };
  }
}
mock.module("../../native", () => ({ ...native, NativeHid: Hid, NativeCapture: Capture }));
mock.module("../../ui-settings", () => ({ ...ui, refreshDeviceOptionState: async () => {} }));
mock.module("../../ax", () => ({
  ...ax,
  isSoftwareKeyboardVisible: async () => {
    if (keyboardProbe) {
      entered();
      return keyboardProbe;
    }
    return keyboardVisible;
  },
}));
mock.module("../../sim-pasteboard-copy", () => ({
  ...copy,
  copyFromSim: async (
    _udid: string,
    sendShortcut: () => Promise<void>,
    inInputTurn: (copy: () => Promise<string>) => Promise<string>,
  ) => ({
    text: await inInputTurn(async () => {
      copyTurns++;
      copyEntered();
      await copyTurnGate;
      await sendShortcut();
      return "selected text";
    }),
  }),
}));
const { DeviceSession } = await import("../../device-session");
class Socket extends EventEmitter {
  closedCode?: number;
  send() {}
  close(code?: number) {
    this.closedCode = code;
    this.emit("close");
  }
}
let session: InstanceType<typeof DeviceSession>;
afterEach(() => {
  copyTurnGate = undefined;
  copyEntered = () => {};
  copyTurns = 0;
  session?.close();
  unknownHingeState = false;
  hingeReadGate = undefined;
  supportReadGate = undefined;
  gate = undefined;
  keyboardProbe = undefined;
  keyboardGate = undefined;
});
async function start() {
  writeSavedHingeState("00000000-0000-0000-0000-000000000333", {});
  handles.length = 0;
  suspended = 0;
  keyboardVisible = true;
  nativeHingeAngle = 180;
  nativePhysicalOrientation = undefined;
  session = new DeviceSession("00000000-0000-0000-0000-000000000333");
  await session.start();
  const socket = new Socket();
  session.attachHidSocket(socket as never);
  return socket;
}
function send(socket: Socket, tag: number, body: object) {
  socket.emit("message", Buffer.concat([Buffer.from([tag]), Buffer.from(JSON.stringify(body))]));
}

test("rebinds an unchanged active panel to the replacement HID before admission", async () => {
  await start();
  expect(handles[0]!.screens).toEqual([3]);
  await session.suspendForReboot();
  await session.resumeAfterReboot();
  expect(handles[1]!.screens).toEqual([3]);
  await (session as any).refreshScreenSizeFromNative();
  expect(handles[1]!.screens).toEqual([3]);
});

for (const tag of [0x0f, 0x07]) {
  test(`drains in-flight control ${tag} and discards queued controls from the old socket`, async () => {
    const socket = await start();
    let release = () => {};
    gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const firstEntered = new Promise<void>((resolve) => {
      entered = resolve;
    });
    send(socket, tag, tag === 0x0f ? { angle: 90 } : { orientation: "landscape" });
    send(socket, tag, tag === 0x0f ? { angle: 30 } : { orientation: "portrait" });
    await firstEntered;
    const pause = session.suspendForReboot();
    await Bun.sleep(10);
    expect(suspended).toBe(0);
    release();
    await pause;
    await session.resumeAfterReboot();
    expect(handles[0]!.angles).toEqual(tag === 0x0f ? [90] : []);
    expect(handles[0]!.rotations.length).toBe(tag === 0x07 ? 1 : 0);
    expect(handles[1]!.angles).toEqual([]);
    expect(handles[1]!.rotations).toEqual([]);
  });
}

test("suspension also drains a control whose socket disconnected before reboot", async () => {
  const socket = await start();
  let release = () => {};
  gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  const firstEntered = new Promise<void>((resolve) => {
    entered = resolve;
  });
  send(socket, 0x0f, { angle: 90 });
  await firstEntered;
  socket.close();
  const pause = session.suspendForReboot();
  await Bun.sleep(10);
  expect(suspended).toBe(0);
  release();
  await pause;
  await session.resumeAfterReboot();
  expect(handles[1]!.angles).toEqual([]);
});

test("ordinary disconnection preserves accepted same-boot hinge controls", async () => {
  const socket = await start();
  let release = () => {};
  gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  const firstEntered = new Promise<void>((resolve) => {
    entered = resolve;
  });
  send(socket, 0x0f, { angle: 90 });
  send(socket, 0x0f, { angle: 30 });
  await firstEntered;
  socket.close();
  release();
  gate = undefined;
  await (session as any).hingeControlUpdate;
  expect(handles[0]!.angles).toEqual([90, 30]);
});

test("drains and cancels an old keyboard visibility probe before reboot", async () => {
  const socket = await start();
  let release = () => {};
  keyboardProbe = new Promise((resolve) => {
    release = () => resolve(true);
  });
  const firstEntered = new Promise<void>((resolve) => {
    entered = resolve;
  });
  send(socket, 0x0d, { visible: false });
  await firstEntered;
  const pause = session.suspendForReboot();
  await Bun.sleep(10);
  const pausedBeforeProbe = suspended;
  release();
  await pause;
  keyboardProbe = undefined;
  keyboardVisible = false;
  await session.resumeAfterReboot();
  const freshSocket = new Socket();
  session.attachHidSocket(freshSocket as never);
  send(freshSocket, 0x0d, { visible: false });
  await Bun.sleep(0); // Let socket admission dispatch the accepted message.
  await (session as any).softwareKeyboardSync;
  expect(pausedBeforeProbe).toBe(0);
  expect(handles[0]!.keyboardToggles).toBe(0);
  expect(handles[1]!.keyboardToggles).toBe(0);
  expect(keyboardVisible).toBe(false);
});

test("resets hidden keyboard state before accepting new-boot intent", async () => {
  const socket = await start();
  send(socket, 0x0d, { visible: false });
  await Bun.sleep(0); // Let socket admission dispatch the accepted message.
  await (session as any).softwareKeyboardSync;
  expect(keyboardVisible).toBe(false);
  await session.suspendForReboot();
  keyboardVisible = true;
  await session.resumeAfterReboot();
  const freshSocket = new Socket();
  session.attachHidSocket(freshSocket as never);
  send(freshSocket, 0x0d, { visible: false });
  await Bun.sleep(0); // Let socket admission dispatch the accepted message.
  await (session as any).softwareKeyboardSync;
  expect(handles[1]!.keyboardToggles).toBe(1);
  expect(keyboardVisible).toBe(false);
});

for (const tag of [0x0c, 0x0d]) {
  test(`drains a native keyboard toggle ${tag} before shutdown`, async () => {
    const socket = await start();
    let release = () => {};
    keyboardGate = new Promise((resolve) => {
      release = resolve;
    });
    const firstEntered = new Promise<void>((resolve) => {
      entered = resolve;
    });
    send(socket, tag, { visible: false });
    await firstEntered;
    const pause = session.suspendForReboot();
    await Bun.sleep(10);
    const pausedBeforeToggle = suspended;
    release();
    await pause;
    expect(pausedBeforeToggle).toBe(0);
    expect(handles[0]!.keyboardToggles).toBe(1);
  });
}

test("coalesces keyboard intent across an ordinary same-boot disconnect", async () => {
  const socket = await start();
  let release = () => {};
  keyboardProbe = new Promise((resolve) => {
    release = () => resolve(true);
  });
  const firstEntered = new Promise<void>((resolve) => {
    entered = resolve;
  });
  send(socket, 0x0d, { visible: false });
  await firstEntered;
  socket.close();
  const freshSocket = new Socket();
  session.attachHidSocket(freshSocket as never);
  send(freshSocket, 0x0d, { visible: false });
  release();
  await Bun.sleep(0); // Let socket admission dispatch the accepted message.
  await (session as any).softwareKeyboardSync;
  expect(handles[0]!.keyboardToggles).toBe(1);
  expect(keyboardVisible).toBe(false);
});

for (const [tag, body] of [
  [0x04, { button: "app-switcher" }],
  [0x04, { button: "home", page: 12, usage: 64 }],
  [0x08, { option: "flash", enabled: true }],
  [0x09, {}],
  [0x0a, { delta: 1 }],
  [0x0c, {}],
] as const) {
  for (const disconnected of [false, true]) {
    test(`drains native control ${tag} ${JSON.stringify(body)} after disconnected=${disconnected}`, async () => {
      const socket = await start();
      let release = () => {};
      keyboardGate = new Promise((resolve) => {
        release = resolve;
      });
      const firstEntered = new Promise<void>((resolve) => {
        entered = resolve;
      });
      send(socket, tag, body);
      await firstEntered;
      if (disconnected) socket.close();
      const pause = session.suspendForReboot();
      await Bun.sleep(10);
      const pausedBeforeNativeCompletion = suspended;
      release();
      await pause;
      expect(pausedBeforeNativeCompletion).toBe(0);
    });
  }
}

for (const pending of ["capability discovery", "hinge state"] as const) {
  test(`restarts ${pending} after reboot cancels startup hydration`, async () => {
    let release = () => {};
    const blocked = new Promise<void>((resolve) => {
      release = resolve;
    });
    const reading = new Promise<void>((resolve) => {
      entered = resolve;
    });
    if (pending === "capability discovery") supportReadGate = blocked;
    else hingeReadGate = blocked;
    await start();
    await reading;
    const suspension = session.suspendForReboot();
    await Bun.sleep(5);
    release();
    await suspension;
    hingeReadGate = undefined;
    supportReadGate = undefined;
    await session.resumeAfterReboot();
    for (let i = 0; i < 20 && (session as any).supportsHingeAngle !== true; i++) await Bun.sleep(5);
    expect((session as any).supportsHingeAngle).toBe(true);
    expect((session as any).hingeAngle).toBe(180);
  });
}

test("refreshes native hinge state when reboot discards a completed command result", async () => {
  const socket = await start();
  await (session as any).hingeControlUpdate;
  let release = () => {};
  gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  const reading = new Promise<void>((resolve) => {
    entered = resolve;
  });
  send(socket, 0x0f, { angle: 90 });
  await reading;
  const suspension = session.suspendForReboot();
  release();
  await suspension;
  gate = undefined;
  expect(nativeHingeAngle).toBe(90);
  await session.resumeAfterReboot();
  await Bun.sleep(0);
  await (session as any).hingeControlUpdate;
  expect((session as any).hingeAngle).toBe(90);
});

for (const pending of ["capability discovery", "hinge state"] as const) {
  test(`waits for new-boot ${pending} before admitting input`, async () => {
    await start();
    await (session as any).hingeControlUpdate;
    await session.suspendForReboot();
    let release = () => {};
    const blocked = new Promise<void>((resolve) => {
      release = resolve;
    });
    const reading = new Promise<void>((resolve) => {
      entered = resolve;
    });
    if (pending === "capability discovery") supportReadGate = blocked;
    else hingeReadGate = blocked;
    let ready = false;
    const resume = session.resumeAfterReboot().then(() => {
      ready = true;
    });
    await reading;
    const early = new Socket();
    session.attachHidSocket(early as never);
    expect(early.closedCode).toBe(1013);
    expect(ready).toBe(false);
    release();
    await resume;
    supportReadGate = undefined;
    hingeReadGate = undefined;
    const fresh = new Socket();
    session.attachHidSocket(fresh as never);
    expect(fresh.closedCode).toBeUndefined();
    send(fresh, 0x0f, { angle: 90 });
    await Bun.sleep(0);
    await (session as any).hingeControlUpdate;
    send(fresh, 0x07, { orientation: "landscape_left" });
    await Bun.sleep(0);
    await (session as any).hingeControlUpdate;
    expect((session as any).hingePhysicalOrientation).toBeUndefined();
  });
}

test("unknown reboot state preserves saved pose and permits a later native read retry", async () => {
  await start();
  await Bun.sleep(0);
  await (session as any).hingeControlUpdate;
  expect(await (session as any).queueHingeControl({ control: "pose", value: "book" })).toBe(true);
  await session.suspendForReboot();
  unknownHingeState = true;
  await session.resumeAfterReboot();
  unknownHingeState = false;
  nativePhysicalOrientation = undefined;
  expect(readSavedHingeState("00000000-0000-0000-0000-000000000333", 90)?.hingePose).toBe("book");
  expect(await (session as any).queueHingeControl({ control: "table", value: true })).toBe(true);
});

test("HTTP Copy is refused while reboot is suspended and resumes on replacement HID", async () => {
  await start();
  await session.suspendForReboot();
  await expect(session.copyPasteboard()).rejects.toThrow();
  expect(copyTurns).toBe(0);
  expect(handles[0]!.keys).toEqual([]);
  await session.resumeAfterReboot();
  expect((await session.copyPasteboard()).text).toBe("selected text");
  expect(handles[0]!.keys).toEqual([]);
  expect(handles[1]!.keys).toEqual(["down:227", "down:6", "up:6", "up:227"]);
});

test("reboot drains an accepted HTTP Copy but refuses a new Copy during the drain", async () => {
  await start();
  let release = () => {};
  copyTurnGate = new Promise<void>((resolve) => {
    release = resolve;
  });
  const copying = new Promise<void>((resolve) => {
    copyEntered = resolve;
  });
  const accepted = session.copyPasteboard();
  await copying;
  let done = false;
  const suspension = session.suspendForReboot().then(() => {
    done = true;
  });
  await Bun.sleep(0);
  try {
    expect(done).toBe(false);
    expect(suspended).toBe(0);
    const refused = session.copyPasteboard().then(
      () => "resolved",
      () => "rejected",
    );
    const outcome = await Promise.race([refused, Bun.sleep(25).then(() => "pending")]);
    expect(outcome).toBe("rejected");
    expect(copyTurns).toBe(1);
  } finally {
    release();
    await accepted;
    await suspension;
  }
  expect(handles[0]!.keys).toEqual(["down:227", "down:6", "up:6", "up:227"]);
  expect(done).toBe(true);
  expect(suspended).toBe(1);
});
