import { afterEach, expect, test } from "bun:test";
import { Window } from "happy-dom";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";

import { Button } from "../components/Button";
import { createGlobalStubs } from "./test-globals";

const { stubGlobal, restoreGlobals } = createGlobalStubs();
let root: Root | undefined;
let dom: Window | undefined;

afterEach(async () => {
  if (root) await act(async () => root?.unmount());
  await dom?.happyDOM.close();
  root = undefined;
  dom = undefined;
  restoreGlobals();
});

test("forwards mouse callbacks while CSS handles press and hover states", async () => {
  dom = new Window();
  stubGlobal("window", dom);
  stubGlobal("document", dom.document);
  stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  const container = dom.document.createElement("div");
  dom.document.body.append(container);
  root = createRoot(container as unknown as HTMLDivElement);
  const events: string[] = [];
  await act(async () => {
    root!.render(
      <Button
        onMouseEnter={(event) => events.push(`enter:${event.currentTarget.tagName}`)}
        onMouseLeave={() => events.push("leave")}
        onMouseDown={() => events.push("down")}
        onMouseUp={() => events.push("up")}
      >
        Drag
      </Button>,
    );
  });
  const button = container.querySelector("button")!;
  expect(button.classList.contains("hub-pressable")).toBe(true);
  const dispatch = async (type: string) => {
    await act(async () => {
      button.dispatchEvent(new dom!.MouseEvent(type, { bubbles: true }));
    });
  };
  await dispatch("mouseover");
  await dispatch("mousedown");
  await dispatch("mouseup");
  await dispatch("mousedown");
  await dispatch("mouseout");
  expect(events).toEqual(["enter:BUTTON", "down", "up", "down", "leave"]);
});
