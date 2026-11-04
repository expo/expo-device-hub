import { expect, test, mock } from "bun:test";
import { createElement, type DragEvent } from "react";
import { act, create, type ReactTestRenderer } from "react-test-renderer";
import { useAppDrop } from "../dashboard/AppDrop";

Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });

test("queues valid apps and rejects invalid folders before the active install finishes", async () => {
  let finish!: () => void;
  const pending = new Promise<void>((resolve) => {
    finish = resolve;
  });
  const backend = { installFolder: mock(async () => pending), installFile: mock(async () => {}) };
  let renderer!: ReactTestRenderer;
  function Harness() {
    const drop = useAppDrop(backend, true);
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
