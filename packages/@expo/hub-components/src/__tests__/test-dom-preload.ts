import { Window } from "happy-dom";

// Radix selects its client layout effect when imported. Load it with a DOM
// so dialog titles and descriptions register as in a browser. Each test still
// installs and restores its own globals; SSR tests keep their original environment.
const window = new Window();
const original = Object.getOwnPropertyDescriptor(globalThis, "document");
try {
  Object.defineProperty(globalThis, "document", {
    value: window.document,
    configurable: true,
    writable: true,
  });
  await import("@radix-ui/react-dialog");
} finally {
  if (original) Object.defineProperty(globalThis, "document", original);
  else Reflect.deleteProperty(globalThis, "document");
  await window.happyDOM.close();
}
