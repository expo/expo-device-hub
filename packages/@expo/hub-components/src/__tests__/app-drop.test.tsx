import { expect, test, mock } from "bun:test";
import { createElement, type DragEvent } from "react";
import { act, create, type ReactTestRenderer } from "react-test-renderer";
import { useAppDrop } from "../dashboard/AppDrop";
import { Button } from "../primitives";

Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });

test("queues valid apps and rejects invalid folders before the active install finishes", async () => {
  let finish!: () => void;
  const pending = new Promise<void>((resolve) => {
    finish = resolve;
  });
  const backend = { installFolder: mock(async () => pending), installFile: mock(async () => {}) };
  let renderer!: ReactTestRenderer;
  function Harness() {
    const drop = useAppDrop(backend, true, "device-a");
    return createElement("section", drop.props, drop.notice);
  }
  try {
    await act(async () => {
      renderer = create(createElement(Harness));
    });
    await act(async () => {
      renderer.root.findByType("section").props.onDrop({
        preventDefault() {},
        stopPropagation() {},
        dataTransfer: {
          files: [new File([], "One.app"), new File([], "Two.tgz"), new File([], "Photos")],
          items: [
            { kind: "file", webkitGetAsEntry: () => ({ isDirectory: true, name: "One.app" }) },
            { kind: "file", webkitGetAsEntry: () => null },
            { kind: "file", webkitGetAsEntry: () => ({ isDirectory: true, name: "Photos" }) },
          ],
        },
      } as unknown as DragEvent);
    });
    expect(backend.installFolder).toHaveBeenCalledTimes(1);
    expect(backend.installFile).toHaveBeenCalledTimes(0);
    const content = JSON.stringify(renderer.toJSON());
    expect(content).toContain("Waiting to upload Two.tgz");
    expect(content).toContain("Drop a Simulator .app folder or .tar.gz/.tgz archive");
    await act(async () => {
      finish();
      await pending;
    });
    expect(backend.installFile).toHaveBeenCalledTimes(1);
  } finally {
    finish();
    await act(async () => renderer?.unmount());
  }
});

test("keeps queued installs and their notices with the device that received the drop", async () => {
  let finish!: () => void;
  const pending = new Promise<void>((resolve) => {
    finish = resolve;
  });
  const firstBackend = {
    installFolder: mock(async () => {}),
    installFile: mock(async (file: File) => {
      if (file.name === "First.tgz") await pending;
    }),
  };
  const secondBackend = {
    installFolder: mock(async () => {}),
    installFile: mock(async (_file: File) => {}),
  };
  let renderer!: ReactTestRenderer;
  function Harness({ deviceId, backend }: { deviceId: string; backend: typeof firstBackend }) {
    const drop = useAppDrop(backend, true, deviceId);
    return createElement("section", drop.props, drop.notice);
  }
  const dropFiles = (names: string[]) =>
    renderer.root.findByType("section").props.onDrop({
      preventDefault() {},
      stopPropagation() {},
      dataTransfer: {
        files: names.map((name) => new File([], name)),
        items: names.map(() => ({ kind: "file", webkitGetAsEntry: () => null })),
      },
    } as unknown as DragEvent);
  try {
    await act(async () => {
      renderer = create(createElement(Harness, { deviceId: "device-a", backend: firstBackend }));
    });
    await act(async () => dropFiles(["First.tgz", "Second.tgz"]));
    expect(firstBackend.installFile).toHaveBeenCalledTimes(1);
    expect(JSON.stringify(renderer.toJSON())).toContain("Waiting to upload Second.tgz");

    await act(async () => {
      renderer.update(createElement(Harness, { deviceId: "device-b", backend: secondBackend }));
    });
    expect(JSON.stringify(renderer.toJSON())).not.toContain("First.tgz");
    expect(JSON.stringify(renderer.toJSON())).not.toContain("Second.tgz");
    await act(async () => dropFiles(["Third.tgz"]));
    expect(secondBackend.installFile).toHaveBeenCalledTimes(0);
    await act(async () => {
      finish();
      await pending;
    });
    expect(firstBackend.installFile.mock.calls.map(([file]) => file.name)).toEqual([
      "First.tgz",
      "Second.tgz",
    ]);
    expect(secondBackend.installFile.mock.calls.map(([file]) => file.name)).toEqual(["Third.tgz"]);
    expect(JSON.stringify(renderer.toJSON())).toContain("Installed Third.tgz");
    expect(JSON.stringify(renderer.toJSON())).not.toContain("First.tgz");
    await act(async () => {
      renderer.update(createElement(Harness, { deviceId: "device-a", backend: firstBackend }));
    });
    expect(JSON.stringify(renderer.toJSON())).toContain("Installed First.tgz");
    expect(JSON.stringify(renderer.toJSON())).toContain("Installed Second.tgz");
    expect(JSON.stringify(renderer.toJSON())).not.toContain("Third.tgz");
  } finally {
    finish();
    await act(async () => renderer?.unmount());
  }
});

test("accepts archives and gives folder guidance without the directory entry API", async () => {
  const backend = {
    installFolder: mock(async () => {}),
    installFile: mock(async (_file: File) => {}),
  };
  let renderer!: ReactTestRenderer;
  function Harness() {
    const drop = useAppDrop(backend, true, "device-a");
    return createElement("section", drop.props, drop.notice);
  }
  try {
    await act(async () => {
      renderer = create(createElement(Harness));
    });
    await act(async () => {
      renderer.root.findByType("section").props.onDrop({
        preventDefault() {},
        stopPropagation() {},
        dataTransfer: {
          files: [new File([], "Archive.tgz"), new File([], "Folder.app")],
          items: [{ kind: "file" }, { kind: "file" }],
        },
      } as unknown as DragEvent);
    });
    expect(backend.installFile).toHaveBeenCalledTimes(1);
    expect(backend.installFile.mock.calls[0][0].name).toBe("Archive.tgz");
    expect(backend.installFolder).toHaveBeenCalledTimes(0);
    expect(JSON.stringify(renderer.toJSON())).toContain(
      "Drop a Simulator .app folder or .tar.gz/.tgz archive",
    );
  } finally {
    await act(async () => renderer?.unmount());
  }
});

test("dismisses a notice through the shared button with an accessible name", async () => {
  const backend = { installFolder: mock(async () => {}), installFile: mock(async () => {}) };
  let renderer!: ReactTestRenderer;
  function Harness() {
    const drop = useAppDrop(backend, true, "device-a");
    return createElement("section", drop.props, drop.notice);
  }
  try {
    await act(async () => {
      renderer = create(createElement(Harness));
    });
    await act(async () => {
      renderer.root.findByType("section").props.onDrop({
        preventDefault() {},
        stopPropagation() {},
        dataTransfer: {
          files: [new File([], "unsupported.zip")],
          items: [{ kind: "file", webkitGetAsEntry: () => null }],
        },
      } as unknown as DragEvent);
    });
    expect(renderer.root.findAllByType(Button)).toHaveLength(1);
    expect(JSON.stringify(renderer.toJSON())).toContain("Dismiss app upload");
    expect(JSON.stringify(renderer.toJSON())).toContain("Drop a Simulator .app folder");
    await act(async () => renderer.root.findByType("button").props.onClick());
    expect(JSON.stringify(renderer.toJSON())).not.toContain("Drop a Simulator .app folder");
  } finally {
    await act(async () => renderer?.unmount());
  }
});
