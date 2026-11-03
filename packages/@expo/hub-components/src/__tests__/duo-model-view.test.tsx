import { afterEach, expect, mock, test } from "bun:test";
import { act, create, type ReactTestRenderer } from "react-test-renderer";

import * as scene from "../foldable/duo-scene";
import { createGlobalStubs } from "./test-globals";

type SceneCallbacks = Parameters<typeof scene.createDuoScene>[3];

// The real scene needs WebGL. A test that sets `fakeScene` gets its callbacks;
// every other caller still gets the real scene.
const realCreateDuoScene = scene.createDuoScene;
let fakeScene: ((callbacks: SceneCallbacks) => void) | null = null;
mock.module("../foldable/duo-scene", () => ({
  ...scene,
  createDuoScene: (...args: Parameters<typeof scene.createDuoScene>) => {
    if (!fakeScene) return realCreateDuoScene(...args);
    fakeScene(args[3]);
    return { dispose() {} };
  },
}));
const { DuoModelView } = await import("../foldable/DuoModelView");

const { stubGlobal, restoreGlobals } = createGlobalStubs();
let renderer: ReactTestRenderer | undefined;
afterEach(async () => {
  await act(async () => renderer?.unmount());
  renderer = undefined;
  fakeScene = null;
  restoreGlobals();
});

test("a scene error after the model is ready falls back to the flat displays", async () => {
  stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  stubGlobal("document", { hidden: false, addEventListener() {}, removeEventListener() {} });
  let callbacks: SceneCallbacks | undefined;
  fakeScene = (next) => {
    callbacks = next;
  };
  const statuses: string[] = [];
  let unavailable = 0;
  await act(async () => {
    renderer = create(
      <DuoModelView
        modelUrl="https://hub.test/grid/api/devicekit-model"
        activeScreenId={1}
        onStatusChange={(status) => statuses.push(status)}
        onUnavailable={() => unavailable++}
      >
        <div />
      </DuoModelView>,
      { createNodeMock: () => ({}) },
    );
  });
  await act(async () => callbacks!.ready());
  expect(renderer!.root.findByProps({ "data-duo-model": "ready" })).toBeDefined();

  // For example, the browser drops the WebGL context.
  await act(async () => callbacks!.error());
  expect(renderer!.root.findByProps({ "data-duo-model": "unavailable" })).toBeDefined();
  expect(statuses).toEqual(["loading", "ready", "unavailable"]);
  expect(unavailable).toBe(1);
  // A late ready does not bring the failed model back.
  await act(async () => callbacks!.ready());
  expect(renderer!.root.findByProps({ "data-duo-model": "unavailable" })).toBeDefined();
});
