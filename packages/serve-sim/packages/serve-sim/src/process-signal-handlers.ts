const fallbackHandlers = new WeakSet<object>();

export function markFallbackSignalHandler(handler: (signal: NodeJS.Signals) => void): void {
  fallbackHandlers.add(handler);
}

/** Library cleanup hooks defer to the host that owns its shutdown. */
export function hasHostSignalHandler(signal: NodeJS.Signals): boolean {
  return process.listeners(signal).some((handler) => !fallbackHandlers.has(handler));
}
