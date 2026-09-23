/** Keep stubs isolated per test file while restoring their original descriptors. */
export function createGlobalStubs() {
  const originals = new Map<string, PropertyDescriptor | undefined>();

  return {
    stubGlobal(name: string, value: unknown) {
      originals.set(name, Object.getOwnPropertyDescriptor(globalThis, name));
      Object.defineProperty(globalThis, name, { value, configurable: true, writable: true });
    },
    restoreGlobals() {
      for (const [name, descriptor] of originals) {
        if (descriptor) Object.defineProperty(globalThis, name, descriptor);
        else Reflect.deleteProperty(globalThis, name);
      }
      originals.clear();
    },
  };
}
