import { afterEach, expect, test } from "bun:test";
import { memo, useEffect, useLayoutEffect, type ReactElement } from "react";
import { act, create, type ReactTestRenderer } from "react-test-renderer";

import { DeviceClientStoreContext, useDeviceClientSelector } from "../DeviceClientProvider";
import { createDeviceClientStore } from "../device-client-store";
import type { DeviceClient, MultiTouchSample } from "../types";
import { useDeviceClient } from "../useDeviceClient";
import { createGlobalStubs } from "./test-globals";

const { stubGlobal, restoreGlobals } = createGlobalStubs();
let renderer: ReactTestRenderer | undefined;

afterEach(async () => {
  if (renderer) await act(async () => renderer?.unmount());
  renderer = undefined;
  restoreGlobals();
});

async function mount(children: ReactElement) {
  stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  await act(async () => {
    renderer = create(children);
  });
}

const presenceChecks = [
  { name: "in", has: (client: DeviceClient, key: PropertyKey) => key in client },
  {
    name: "Object.hasOwn",
    has: (client: DeviceClient, key: PropertyKey) => Object.hasOwn(client, key),
  },
  {
    name: "hasOwnProperty",
    has: (client: DeviceClient, key: PropertyKey) => client.hasOwnProperty(key),
  },
];

test("an unchanged client does not restart effects or render memoized children", async () => {
  const store = createDeviceClientStore();
  let childRenders = 0;
  let attachments = 0;
  let detachments = 0;
  const Child = memo(function Child({ client }: { client: DeviceClient }) {
    childRenders++;
    return <span>{client.status}</span>;
  });
  function Parent({ label }: { label: string }) {
    const client = useDeviceClient();
    useEffect(() => {
      attachments++;
      return () => {
        detachments++;
      };
    }, [client]);
    return (
      <div aria-label={label}>
        <Child client={client} />
      </div>
    );
  }
  const tree = (label: string) => (
    <DeviceClientStoreContext.Provider value={store}>
      <Parent label={label} />
    </DeviceClientStoreContext.Provider>
  );
  await mount(tree("first"));
  expect(childRenders).toBe(1);
  expect(attachments).toBe(1);
  await act(async () => renderer!.update(tree("second")));
  expect(childRenders).toBe(1);
  expect(attachments).toBe(1);
  expect(detachments).toBe(0);
  await act(async () => store.publish({ ...store.getSnapshot(), status: "streaming" }));
  expect(childRenders).toBe(2);
  expect(attachments).toBe(2);
  expect(detachments).toBe(1);
});

test("destructured controls ignore unread updates and receive status and callback changes", async () => {
  const store = createDeviceClientStore();
  const renders = { controls: 0, fps: 0, unused: 0 };
  let controls!: Pick<DeviceClient, "status" | "screenshot" | "rotate" | "pressButton" | "reload">;
  let fps = 0;
  function Controls() {
    const { status, screenshot, rotate, pressButton, reload } = useDeviceClient();
    controls = { status, screenshot, rotate, pressButton, reload };
    renders.controls++;
    return null;
  }
  function Fps() {
    fps = useDeviceClient().fps;
    renders.fps++;
    return null;
  }
  function Unused() {
    useDeviceClient();
    renders.unused++;
    return null;
  }
  await mount(
    <DeviceClientStoreContext.Provider value={store}>
      <Controls />
      <Fps />
      <Unused />
    </DeviceClientStoreContext.Provider>,
  );
  const initial = { ...renders };
  await act(async () =>
    store.publish({
      ...store.getSnapshot(),
      logs: [{ id: "1", source: "syslog", message: "new log" }],
    }),
  );
  expect(renders).toEqual(initial);
  await act(async () => store.publish({ ...store.getSnapshot(), fps: 30 }));
  expect(renders).toEqual({ ...initial, fps: initial.fps + 1 });
  expect(fps).toBe(30);
  await act(async () => store.publish({ ...store.getSnapshot(), status: "streaming" }));
  expect(renders).toEqual({ ...initial, controls: initial.controls + 1, fps: initial.fps + 1 });
  expect(controls.status).toBe("streaming");
  const rotate = () => {};
  await act(async () => store.publish({ ...store.getSnapshot(), rotate }));
  expect(renders).toEqual({ ...initial, controls: initial.controls + 2, fps: initial.fps + 1 });
  expect(controls.rotate).toBe(rotate);
});

test("a handler-only callback uses the latest client on the first click and from an older handler", async () => {
  const store = createDeviceClientStore();
  const calls: string[] = [];
  let onClick!: () => void;
  let renders = 0;
  function Controls() {
    const client = useDeviceClient();
    onClick = () => client.rotate();
    renders++;
    return <button onClick={onClick}>Rotate</button>;
  }
  await mount(
    <DeviceClientStoreContext.Provider value={store}>
      <Controls />
    </DeviceClientStoreContext.Provider>,
  );
  const initial = renders;
  const firstHandler = onClick;
  await act(async () =>
    store.publish({ ...store.getSnapshot(), rotate: () => calls.push("first") }),
  );
  expect(renders).toBe(initial);
  await act(async () => onClick());
  expect(calls).toEqual(["first"]);
  await act(async () =>
    store.publish({ ...store.getSnapshot(), rotate: () => calls.push("second") }),
  );
  await act(async () => firstHandler());
  expect(calls).toEqual(["first", "second"]);
});

for (const initiallyAvailable of [false, true]) {
  test(`handler-only optional callbacks read the current ${initiallyAvailable ? "removed" : "added"} value`, async () => {
    const store = createDeviceClientStore();
    const callback = () => {};
    if (initiallyAvailable) {
      store.publish({ ...store.getSnapshot(), sendMultiTouch: callback });
    }
    let readCallback!: () => DeviceClient["sendMultiTouch"];
    let renders = 0;
    function Controls() {
      const client = useDeviceClient();
      readCallback = () => client.sendMultiTouch;
      renders++;
      return null;
    }
    await mount(
      <DeviceClientStoreContext.Provider value={store}>
        <Controls />
      </DeviceClientStoreContext.Provider>,
    );
    const initial = renders;
    await act(async () =>
      store.publish({
        ...store.getSnapshot(),
        sendMultiTouch: initiallyAvailable ? undefined : callback,
      }),
    );
    expect(renders).toBe(initial);
    expect(readCallback()).toBe(initiallyAvailable ? undefined : callback);
  });
}

for (const { name, has } of presenceChecks) {
  test(`${name} checks follow added and removed optional properties during render`, async () => {
    const store = createDeviceClientStore();
    let available = false;
    let renders = 0;
    function Controls() {
      available = has(useDeviceClient(), "sendMultiTouch");
      renders++;
      return <span>{String(available)}</span>;
    }
    await mount(
      <DeviceClientStoreContext.Provider value={store}>
        <Controls />
      </DeviceClientStoreContext.Provider>,
    );
    expect(available).toBe(false);
    const initial = renders;
    // Presence changes even when the new property's value is undefined.
    await act(async () => store.publish({ ...store.getSnapshot(), sendMultiTouch: undefined }));
    expect(available).toBe(true);
    expect(renders).toBe(initial + 1);
    const withoutMultiTouch = { ...store.getSnapshot() };
    delete withoutMultiTouch.sendMultiTouch;
    await act(async () => store.publish(withoutMultiTouch));
    expect(available).toBe(false);
    expect(renders).toBe(initial + 2);
  });

  for (const initiallyAvailable of [false, true]) {
    test(`a retained handler's ${name} check follows callback ${initiallyAvailable ? "removal" : "addition"} without another render`, async () => {
      const store = createDeviceClientStore();
      const sample: MultiTouchSample = {
        phase: "begin",
        a: { x: 0.2, y: 0.2 },
        b: { x: 0.8, y: 0.8 },
      };
      const calls: MultiTouchSample[] = [];
      const callback = (touch: MultiTouchSample) => {
        calls.push(touch);
      };
      if (initiallyAvailable) store.publish({ ...store.getSnapshot(), sendMultiTouch: callback });
      let onClick!: () => void;
      let available: boolean | undefined;
      let renders = 0;
      function Controls() {
        const client = useDeviceClient();
        onClick = () => {
          available = has(client, "sendMultiTouch");
          if (available) client.sendMultiTouch!(sample);
        };
        renders++;
        return <button onClick={onClick}>Touch</button>;
      }
      await mount(
        <DeviceClientStoreContext.Provider value={store}>
          <Controls />
        </DeviceClientStoreContext.Provider>,
      );
      const initial = renders;
      const retainedHandler = onClick;
      const next = { ...store.getSnapshot() };
      if (initiallyAvailable) delete next.sendMultiTouch;
      else next.sendMultiTouch = callback;
      await act(async () => store.publish(next));
      expect(renders).toBe(initial);
      await act(async () => retainedHandler());
      expect(available).toBe(!initiallyAvailable);
      expect(calls).toEqual(initiallyAvailable ? [] : [sample]);
      expect(renders).toBe(initial);
    });
  }
}

for (const initiallyPresent of [false, true]) {
  test(`retained data reads and presence checks keep their render snapshot after a property is ${initiallyPresent ? "removed" : "added"}`, async () => {
    type ClientWithLabel = DeviceClient & { label?: string };
    const store = createDeviceClientStore();
    if (initiallyPresent) {
      const initial: ClientWithLabel = { ...store.getSnapshot(), label: "initial" };
      store.publish(initial);
    }
    let readData!: () => { status: DeviceClient["status"]; label?: string; presence: boolean[] };
    let renders = 0;
    function Controls() {
      const client = useDeviceClient() as ClientWithLabel;
      readData = () => ({
        status: client.status,
        label: client.label,
        presence: presenceChecks.map(({ has }) => has(client, "label")),
      });
      renders++;
      return null;
    }
    await mount(
      <DeviceClientStoreContext.Provider value={store}>
        <Controls />
      </DeviceClientStoreContext.Provider>,
    );
    const initial = renders;
    const next: ClientWithLabel = { ...store.getSnapshot(), status: "streaming" };
    if (initiallyPresent) delete next.label;
    else next.label = "new";
    await act(async () => store.publish(next));
    expect(renders).toBe(initial);
    expect(readData()).toEqual({
      status: "idle",
      label: initiallyPresent ? "initial" : undefined,
      presence: presenceChecks.map(() => initiallyPresent),
    });
  });
}

test("own-property checks track changes even while the property remains inherited", async () => {
  const store = createDeviceClientStore();
  const callback = () => {};
  const inherited = Object.assign(Object.create({ sendMultiTouch: callback }), store.getSnapshot());
  store.publish(inherited);
  let own = false;
  let present = false;
  let renders = 0;
  function Controls() {
    const client = useDeviceClient();
    own = Object.hasOwn(client, "sendMultiTouch");
    present = "sendMultiTouch" in client;
    renders++;
    return null;
  }
  await mount(
    <DeviceClientStoreContext.Provider value={store}>
      <Controls />
    </DeviceClientStoreContext.Provider>,
  );
  expect(own).toBe(false);
  expect(present).toBe(true);
  const initial = renders;
  await act(async () => store.publish({ ...store.getSnapshot(), sendMultiTouch: callback }));
  expect(renders).toBe(initial + 1);
  expect(own).toBe(true);
  expect(present).toBe(true);
  await act(async () => store.publish(inherited));
  expect(renders).toBe(initial + 2);
  expect(own).toBe(false);
  expect(present).toBe(true);
});

test("a newly read property has its current value after ignored updates", async () => {
  const store = createDeviceClientStore();
  let selected!: DeviceClient["status"] | number;
  let renders = 0;
  function Selected({ field }: { field: "status" | "fps" }) {
    selected = useDeviceClient()[field];
    renders++;
    return null;
  }
  const tree = (field: "status" | "fps") => (
    <DeviceClientStoreContext.Provider value={store}>
      <Selected field={field} />
    </DeviceClientStoreContext.Provider>
  );
  await mount(tree("status"));
  const initial = renders;
  await act(async () => store.publish({ ...store.getSnapshot(), fps: 30 }));
  expect(renders).toBe(initial);
  await act(async () => renderer!.update(tree("fps")));
  expect(selected).toBe(30);
  await act(async () => {
    store.publish({ ...store.getSnapshot(), fps: 60 });
    store.publish({ ...store.getSnapshot(), fps: 90 });
  });
  expect(selected).toBe(90);
  // Previously read fields remain tracked for this provider, even after a conditional read changes.
  const beforeStatusChange = renders;
  await act(async () => store.publish({ ...store.getSnapshot(), status: "streaming" }));
  expect(renders).toBe(beforeStatusChange + 1);
});

test("tracked controls can use a selector without subscribing to its source property", async () => {
  const store = createDeviceClientStore();
  let renders = 0;
  let connected = false;
  function Controls() {
    const { rotate } = useDeviceClient();
    connected = useDeviceClientSelector((client) => client.status === "streaming");
    renders++;
    return (
      <button disabled={!connected} onClick={rotate}>
        Rotate
      </button>
    );
  }
  await mount(
    <DeviceClientStoreContext.Provider value={store}>
      <Controls />
    </DeviceClientStoreContext.Provider>,
  );
  const initial = renders;
  await act(async () => store.publish({ ...store.getSnapshot(), status: "connecting" }));
  expect(renders).toBe(initial);
  expect(connected).toBe(false);
  await act(async () => store.publish({ ...store.getSnapshot(), status: "streaming" }));
  expect(renders).toBe(initial + 1);
  expect(connected).toBe(true);
  await act(async () => store.publish({ ...store.getSnapshot(), fps: 30 }));
  expect(renders).toBe(initial + 1);
});

test("optional properties are tracked before a backend provides them", async () => {
  const store = createDeviceClientStore();
  let sendMultiTouch: DeviceClient["sendMultiTouch"];
  let renders = 0;
  function Controls() {
    ({ sendMultiTouch } = useDeviceClient());
    renders++;
    return null;
  }
  await mount(
    <DeviceClientStoreContext.Provider value={store}>
      <Controls />
    </DeviceClientStoreContext.Provider>,
  );
  expect(sendMultiTouch).toBeUndefined();
  const initial = renders;
  const callback = () => {};
  await act(async () => store.publish({ ...store.getSnapshot(), sendMultiTouch: callback }));
  expect(sendMultiTouch).toBe(callback);
  expect(renders).toBe(initial + 1);
  await act(async () => store.publish({ ...store.getSnapshot(), sendMultiTouch: undefined }));
  expect(sendMultiTouch).toBeUndefined();
  expect(renders).toBe(initial + 2);
});

test("provider changes reset tracking and unsubscribe from the previous session", async () => {
  const first = createDeviceClientStore();
  const second = createDeviceClientStore();
  second.publish({ ...second.getSnapshot(), fps: 24 });
  let selected!: DeviceClient["status"] | number;
  let renders = 0;
  function Selected({ field }: { field: "status" | "fps" }) {
    selected = useDeviceClient()[field];
    renders++;
    return null;
  }
  const tree = (store: typeof first, field: "status" | "fps") => (
    <DeviceClientStoreContext.Provider value={store}>
      <Selected field={field} />
    </DeviceClientStoreContext.Provider>
  );
  await mount(tree(first, "status"));
  await act(async () => renderer!.update(tree(second, "fps")));
  expect(selected).toBe(24);
  const beforeUpdates = renders;
  await act(async () => first.publish({ ...first.getSnapshot(), status: "streaming" }));
  await act(async () => second.publish({ ...second.getSnapshot(), status: "error" }));
  expect(renders).toBe(beforeUpdates);
  await act(async () => second.publish({ ...second.getSnapshot(), fps: 48 }));
  expect(selected).toBe(48);
  expect(renders).toBe(beforeUpdates + 1);
  await act(async () => renderer!.unmount());
  renderer = undefined;
  const beforeUnmountedUpdates = renders;
  first.publish({ ...first.getSnapshot(), status: "error" });
  second.publish({ ...second.getSnapshot(), fps: 60 });
  expect(renders).toBe(beforeUnmountedUpdates);
});

test("a tracked update before subscription is attached is still displayed", async () => {
  const store = createDeviceClientStore();
  let fps = 0;
  function Fps() {
    ({ fps } = useDeviceClient());
    return <span>{fps}</span>;
  }
  function Publish() {
    useLayoutEffect(() => {
      store.publish({ ...store.getSnapshot(), fps: 30 });
    }, []);
    return null;
  }
  await mount(
    <DeviceClientStoreContext.Provider value={store}>
      <Fps />
      <Publish />
    </DeviceClientStoreContext.Provider>,
  );
  expect(fps).toBe(30);
  expect(renderer!.toJSON()).toEqual({ type: "span", props: {}, children: ["30"] });
});

for (const mode of ["spread", "rest"] as const) {
  test(`${mode} subscribes to all properties, including optional properties added later`, async () => {
    const store = createDeviceClientStore();
    let copy!: Omit<DeviceClient, "status">;
    let renders = 0;
    function AllProperties() {
      const client = useDeviceClient();
      if (mode === "spread") {
        copy = { ...client };
      } else {
        const { status, ...rest } = client;
        void status;
        copy = rest;
      }
      renders++;
      return null;
    }
    await mount(
      <DeviceClientStoreContext.Provider value={store}>
        <AllProperties />
      </DeviceClientStoreContext.Provider>,
    );
    const initial = renders;
    await act(async () => store.publish({ ...store.getSnapshot(), fps: 30 }));
    expect(copy.fps).toBe(30);
    expect(renders).toBe(initial + 1);
    const callback = () => {};
    await act(async () => store.publish({ ...store.getSnapshot(), sendMultiTouch: callback }));
    expect(copy.sendMultiTouch).toBe(callback);
    expect(renders).toBe(initial + 2);
  });
}
