import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { act, create, type ReactTestRenderer } from "react-test-renderer";

import { type AddDeviceTarget, type Device, type NewDeviceOptions } from "../dashboard/data";
import { DeviceSection } from "../dashboard/DeviceSection";
import { NewDeviceForm } from "../dashboard/NewDeviceModal";
import { byLastUsed, isValidDeviceName, suggestDeviceName } from "../dashboard/new-device";
import { createGlobalStubs } from "./test-globals";

const { stubGlobal, restoreGlobals } = createGlobalStubs();
let renderer: ReactTestRenderer | undefined;

beforeEach(() => {
  stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  // The Radix select and menu read these on mount.
  stubGlobal("HTMLFormElement", class {});
  stubGlobal("window", {
    addEventListener() {},
    removeEventListener() {},
    setTimeout,
    clearTimeout,
  });
  stubGlobal("document", { addEventListener() {}, removeEventListener() {} });
});

afterEach(async () => {
  if (renderer) await act(async () => renderer?.unmount());
  renderer = undefined;
  restoreGlobals();
});

function device(name: string, lastUsedAt?: number, booted = false): Device {
  return {
    id: name,
    name,
    version: "iOS 27.0",
    platform: "ios",
    booted,
    physical: false,
    supported: true,
    lastUsedAt,
  };
}

describe("new device helpers", () => {
  test("suggests the model as the name, with the next free number", () => {
    expect(suggestDeviceName("iPhone 17 Pro", [], "ios")).toBe("iPhone 17 Pro");
    expect(
      suggestDeviceName(
        "iPhone 17 Pro",
        [device("iPhone 17 Pro"), device("iPhone 17 Pro 2")],
        "ios",
      ),
    ).toBe("iPhone 17 Pro 3");
    // An AVD name has no spaces.
    expect(suggestDeviceName("Pixel 9 Pro", [], "android")).toBe("Pixel_9_Pro");
    expect(
      suggestDeviceName("Pixel 9", [{ ...device("Pixel_9"), platform: "android" }], "android"),
    ).toBe("Pixel_9_2");
  });

  test("accepts any iOS name and only AVD characters on Android", () => {
    expect(isValidDeviceName("My test device", "ios")).toBe(true);
    expect(isValidDeviceName("  ", "ios")).toBe(false);
    expect(isValidDeviceName("Pixel_9.Pro-2", "android")).toBe(true);
    expect(isValidDeviceName("Pixel 9", "android")).toBe(false);
  });

  test("orders devices by their last use, the newest first", () => {
    expect(byLastUsed([device("a", 1), device("c"), device("b", 5)]).map((d) => d.name)).toEqual([
      "b",
      "a",
      "c",
    ]);
  });
});

const OPTIONS: NewDeviceOptions = {
  runtimes: [
    {
      value: "ios-27-0",
      label: "iOS 27.0",
      models: [
        { value: "iphone-17", label: "iPhone 17", supported: true },
        { value: "iphone-17-pro", label: "iPhone 17 Pro", supported: true },
      ],
    },
    {
      value: "ios-26-5",
      label: "iOS 26.5",
      models: [{ value: "iphone-16", label: "iPhone 16", supported: false }],
    },
  ],
};

/** The form of the modal, alone: react-test-renderer does not render the dialog's portal. */
async function renderForm(
  onAdd: (target: AddDeviceTarget) => Promise<{ ok: true } | { ok: false; error: string }>,
  onClose = () => {},
) {
  await act(async () => {
    renderer = create(
      <NewDeviceForm
        kind="simulator"
        existing={[device("iPhone 17")]}
        options={OPTIONS}
        onAdd={onAdd}
        onClose={onClose}
      />,
    );
  });
  return renderer!.root;
}

describe("NewDeviceModal form", () => {
  test("starts with the first runtime and model, and suggests a free name", async () => {
    const root = await renderForm(async () => ({ ok: true }));
    const selects = root.findAll((node) => node.props.size === "lg" && "options" in node.props);

    expect(selects.map((node) => node.props.ariaLabel)).toEqual(["OS version", "Model"]);
    expect(selects.map((node) => node.props.value)).toEqual(["ios-27-0", "iphone-17"]);
    // "iPhone 17" exists, so the suggestion takes the next number.
    expect(root.findByType("input").props.placeholder).toBe("iPhone 17 2");
  });

  test("creates the device with the suggested name and closes on success", async () => {
    const targets: AddDeviceTarget[] = [];
    let closed = 0;
    const root = await renderForm(
      async (target) => {
        targets.push(target);
        return { ok: true };
      },
      () => closed++,
    );
    await act(async () => root.findByType("form").props.onSubmit({ preventDefault() {} }));

    expect(targets).toEqual([
      {
        kind: "new",
        device: {
          platform: "ios",
          name: "iPhone 17 2",
          runtime: "ios-27-0",
          deviceType: "iphone-17",
          version: "iOS 27.0",
          supported: true,
          model: "iPhone 17",
        },
      },
    ]);
    expect(closed).toBe(1);
  });

  test("keeps the form open and shows the host's reason when the device does not start", async () => {
    let closed = 0;
    const root = await renderForm(
      async () => ({ ok: false, error: "The runtime is not installed." }),
      () => closed++,
    );
    await act(async () => root.findByType("form").props.onSubmit({ preventDefault() {} }));

    expect(closed).toBe(0);
    expect(root.findByProps({ role: "alert" }).props.children).toBe(
      "The runtime is not installed.",
    );
  });

  test("a new runtime on iOS takes its first model, and a typed name stays", async () => {
    const root = await renderForm(async () => ({ ok: true }));
    await act(async () =>
      root.findByType("input").props.onChange({ currentTarget: { value: "QA phone" } }),
    );
    const runtime = root.find(
      (node) => node.props.ariaLabel === "OS version" && "options" in node.props,
    );
    await act(async () => runtime.props.onChange("ios-26-5"));

    const model = root.find((node) => node.props.ariaLabel === "Model" && "options" in node.props);
    expect(model.props.value).toBe("iphone-16");
    expect(root.findByType("input").props.value).toBe("QA phone");
  });
});

describe("DeviceSection add flow", () => {
  const section = (
    onAdd: (target: AddDeviceTarget) => Promise<{ ok: true } | { ok: false; error: string }>,
  ) => (
    <DeviceSection
      title="Simulators"
      addLabel="Add simulator"
      kind="simulator"
      emptyLabel="No booted simulators."
      devices={[device("Booted phone", 9, true)]}
      recent={[device("Old phone", 1), device("Booted phone", 9, true), device("New phone", 5)]}
      options={OPTIONS}
      selectedId=""
      onSelect={() => {}}
      onAdd={onAdd}
    />
  );
  const menu = () =>
    renderer!.root.find((node) => "recents" in node.props && "onBoot" in node.props);

  test("offers the recent devices that the list does not show, the newest first", async () => {
    await act(async () => {
      renderer = create(section(async () => ({ ok: true })));
    });
    expect((menu().props.recents as Device[]).map((d) => d.name)).toEqual([
      "New phone",
      "Old phone",
    ]);
  });

  test("boots a recent device through onAdd and reports a failure in a dialog", async () => {
    const targets: AddDeviceTarget[] = [];
    await act(async () => {
      renderer = create(
        section(async (target) => {
          targets.push(target);
          return { ok: false, error: "The emulator process ended." };
        }),
      );
    });
    await act(async () => menu().props.onBoot(device("Old phone", 1)));

    expect(targets).toEqual([{ kind: "recent", device: device("Old phone", 1) }]);
    const error = renderer!.root.find(
      (node) => "deviceName" in node.props && "message" in node.props,
    );
    expect(error.props).toMatchObject({
      open: true,
      deviceName: "Old phone",
      message: "The emulator process ended.",
    });
  });

  test("has no add button without an add handler", async () => {
    await act(async () => {
      renderer = create(
        <DeviceSection
          title="Simulators"
          addLabel="Add simulator"
          kind="simulator"
          emptyLabel="No booted simulators."
          devices={[]}
          recent={[]}
          options={OPTIONS}
          selectedId=""
          onSelect={() => {}}
        />,
      );
    });
    expect(renderer!.root.findAll((node) => "recents" in node.props)).toHaveLength(0);
  });
});
