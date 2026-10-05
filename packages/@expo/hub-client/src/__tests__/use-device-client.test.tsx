import { afterEach, expect, test } from "bun:test";
import { memo, useEffect, useLayoutEffect, type ReactElement } from "react";
import { act, create, type ReactTestRenderer } from "react-test-renderer";

import { DeviceClientStoreContext, useDeviceClientSelector } from "../DeviceClientProvider";
import { createDeviceClientStore } from "../device-client-store";
import type { DeviceClient, ScrollSample } from "../types";
import { useDeviceClient } from "../useDeviceClient";
import { createGlobalStubs } from "./test-globals";

const { stubGlobal, restoreGlobals } = createGlobalStubs();
let renderer: ReactTestRenderer | undefined;

afterEach(async () => {
  if (renderer) await act(async () => renderer?.unmount());
  renderer = undefined;
  restoreGlobals();
});

/** Change only the stream FPS, as a real backend does once per second. */
function withFps(client: DeviceClient, fps: number): DeviceClient {
  return {
    ...client,
    stream: { ...client.stream, data: { screen: client.stream.data?.screen ?? null, fps } },
  } as DeviceClient;
}

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
    return <span>{client.inputError}</span>;
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
  await act(async () => store.publish({ ...store.getSnapshot(), inputError: "Input busy" }));
  expect(childRenders).toBe(2);
  expect(attachments).toBe(2);
  expect(detachments).toBe(1);
});

test("destructured controls ignore unread updates and receive status and callback changes", async () => {
  const store = createDeviceClientStore();
  const renders = { controls: 0, fps: 0, unused: 0 };
  let controls!: Pick<
    DeviceClient,
    "inputError" | "screenshot" | "rotate" | "pressButton" | "reload"
  >;
  let fps = 0;
  function Controls() {
    const { inputError, screenshot, rotate, pressButton, reload } = useDeviceClient();
    controls = { inputError, screenshot, rotate, pressButton, reload };
    renders.controls++;
    return null;
  }
  function Fps() {
    fps = useDeviceClient().stream.data?.fps ?? 0;
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
      logs: {
        ...store.getSnapshot().logs,
        status: "ready",
        data: [{ id: "1", source: "syslog", message: "new log" }],
      } as DeviceClient["logs"],
    }),
  );
  expect(renders).toEqual(initial);
  await act(async () => store.publish(withFps(store.getSnapshot(), 30)));
  expect(renders).toEqual({ ...initial, fps: initial.fps + 1 });
  expect(fps).toBe(30);
  await act(async () => store.publish({ ...store.getSnapshot(), inputError: "Input busy" }));
  expect(renders).toEqual({ ...initial, controls: initial.controls + 1, fps: initial.fps + 1 });
  expect(controls.inputError).toBe("Input busy");
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
      store.publish({ ...store.getSnapshot(), sendScroll: callback });
    }
    let readCallback!: () => DeviceClient["sendScroll"];
    let renders = 0;
    function Controls() {
      const client = useDeviceClient();
      readCallback = () => client.sendScroll;
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
        sendScroll: initiallyAvailable ? undefined : callback,
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
      available = has(useDeviceClient(), "sendScroll");
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
    await act(async () => store.publish({ ...store.getSnapshot(), sendScroll: undefined }));
    expect(available).toBe(true);
    expect(renders).toBe(initial + 1);
    const withoutMultiTouch = { ...store.getSnapshot() };
    delete withoutMultiTouch.sendScroll;
    await act(async () => store.publish(withoutMultiTouch));
    expect(available).toBe(false);
    expect(renders).toBe(initial + 2);
  });

  for (const initiallyAvailable of [false, true]) {
    test(`a retained handler's ${name} check follows callback ${initiallyAvailable ? "removal" : "addition"} without another render`, async () => {
      const store = createDeviceClientStore();
      const sample: ScrollSample = { dx: 0, dy: 10, x: 0.5, y: 0.5 };
      const calls: ScrollSample[] = [];
      const callback = (touch: ScrollSample) => {
        calls.push(touch);
      };
      if (initiallyAvailable) store.publish({ ...store.getSnapshot(), sendScroll: callback });
      let onClick!: () => void;
      let available: boolean | undefined;
      let renders = 0;
      function Controls() {
        const client = useDeviceClient();
        onClick = () => {
          available = has(client, "sendScroll");
          if (available) client.sendScroll!(sample);
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
      if (initiallyAvailable) delete next.sendScroll;
      else next.sendScroll = callback;
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
    let readData!: () => {
      inputError: DeviceClient["inputError"];
      label?: string;
      presence: boolean[];
    };
    let renders = 0;
    function Controls() {
      const client = useDeviceClient() as ClientWithLabel;
      readData = () => ({
        inputError: client.inputError,
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
    const next: ClientWithLabel = { ...store.getSnapshot(), inputError: "Input busy" };
    if (initiallyPresent) delete next.label;
    else next.label = "new";
    await act(async () => store.publish(next));
    expect(renders).toBe(initial);
    expect(readData()).toEqual({
      inputError: null,
      label: initiallyPresent ? "initial" : undefined,
      presence: presenceChecks.map(() => initiallyPresent),
    });
  });
}

test("own-property checks track changes even while the property remains inherited", async () => {
  const store = createDeviceClientStore();
  const callback = () => {};
  const inherited = Object.assign(Object.create({ sendScroll: callback }), store.getSnapshot());
  store.publish(inherited);
  let own = false;
  let present = false;
  let renders = 0;
  function Controls() {
    const client = useDeviceClient();
    own = Object.hasOwn(client, "sendScroll");
    present = "sendScroll" in client;
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
  await act(async () => store.publish({ ...store.getSnapshot(), sendScroll: callback }));
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
  let selected!: DeviceClient["inputError"] | number | undefined;
  let renders = 0;
  function Selected({ field }: { field: "status" | "fps" }) {
    const client = useDeviceClient();
    selected = field === "fps" ? client.stream.data?.fps : client.inputError;
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
  await act(async () => store.publish(withFps(store.getSnapshot(), 30)));
  expect(renders).toBe(initial);
  await act(async () => renderer!.update(tree("fps")));
  expect(selected).toBe(30);
  await act(async () => {
    store.publish(withFps(store.getSnapshot(), 60));
    store.publish(withFps(store.getSnapshot(), 90));
  });
  expect(selected).toBe(90);
  // Previously read fields remain tracked for this provider, even after a conditional read changes.
  const beforeStatusChange = renders;
  await act(async () => store.publish({ ...store.getSnapshot(), inputError: "Input busy" }));
  expect(renders).toBe(beforeStatusChange + 1);
});

test("tracked controls can use a selector without subscribing to its source property", async () => {
  const store = createDeviceClientStore();
  let renders = 0;
  let connected = false;
  function Controls() {
    const { rotate } = useDeviceClient();
    connected = useDeviceClientSelector((client) => client.stream.status === "ready");
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
  const withStatus = (status: DeviceClient["stream"]["status"]) =>
    ({
      ...store.getSnapshot(),
      stream: { ...store.getSnapshot().stream, status },
    }) as DeviceClient;
  await act(async () => store.publish(withStatus("loading")));
  expect(renders).toBe(initial);
  expect(connected).toBe(false);
  await act(async () => store.publish(withStatus("ready")));
  expect(renders).toBe(initial + 1);
  expect(connected).toBe(true);
  await act(async () => store.publish(withFps(store.getSnapshot(), 30)));
  expect(renders).toBe(initial + 1);
});

test("optional properties are tracked before a backend provides them", async () => {
  const store = createDeviceClientStore();
  let sendScroll: DeviceClient["sendScroll"];
  let renders = 0;
  function Controls() {
    ({ sendScroll } = useDeviceClient());
    renders++;
    return null;
  }
  await mount(
    <DeviceClientStoreContext.Provider value={store}>
      <Controls />
    </DeviceClientStoreContext.Provider>,
  );
  expect(sendScroll).toBeUndefined();
  const initial = renders;
  const callback = () => {};
  await act(async () => store.publish({ ...store.getSnapshot(), sendScroll: callback }));
  expect(sendScroll).toBe(callback);
  expect(renders).toBe(initial + 1);
  await act(async () => store.publish({ ...store.getSnapshot(), sendScroll: undefined }));
  expect(sendScroll).toBeUndefined();
  expect(renders).toBe(initial + 2);
});

test("provider changes reset tracking and unsubscribe from the previous session", async () => {
  const first = createDeviceClientStore();
  const second = createDeviceClientStore();
  second.publish(withFps(second.getSnapshot(), 24));
  let selected!: DeviceClient["inputError"] | number | undefined;
  let renders = 0;
  function Selected({ field }: { field: "status" | "fps" }) {
    const client = useDeviceClient();
    selected = field === "fps" ? client.stream.data?.fps : client.inputError;
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
  await act(async () => first.publish({ ...first.getSnapshot(), inputError: "Input busy" }));
  await act(async () => second.publish({ ...second.getSnapshot(), inputError: "Input lost" }));
  expect(renders).toBe(beforeUpdates);
  await act(async () => second.publish(withFps(second.getSnapshot(), 48)));
  expect(selected).toBe(48);
  expect(renders).toBe(beforeUpdates + 1);
  await act(async () => renderer!.unmount());
  renderer = undefined;
  const beforeUnmountedUpdates = renders;
  first.publish({ ...first.getSnapshot(), inputError: "Input lost" });
  second.publish(withFps(second.getSnapshot(), 60));
  expect(renders).toBe(beforeUnmountedUpdates);
});

test("a tracked update before subscription is attached is still displayed", async () => {
  const store = createDeviceClientStore();
  let fps = 0;
  function Fps() {
    fps = useDeviceClient().stream.data?.fps ?? 0;
    return <span>{fps}</span>;
  }
  function Publish() {
    useLayoutEffect(() => {
      store.publish(withFps(store.getSnapshot(), 30));
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
    let copy!: Omit<DeviceClient, "inputError">;
    let renders = 0;
    function AllProperties() {
      const client = useDeviceClient();
      if (mode === "spread") {
        copy = { ...client };
      } else {
        const { inputError, ...rest } = client;
        void inputError;
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
    await act(async () => store.publish(withFps(store.getSnapshot(), 30)));
    expect(copy.stream.data?.fps).toBe(30);
    expect(renders).toBe(initial + 1);
    const callback = () => {};
    await act(async () => store.publish({ ...store.getSnapshot(), sendScroll: callback }));
    expect(copy.sendScroll).toBe(callback);
    expect(renders).toBe(initial + 2);
  });
}
