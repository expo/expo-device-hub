const fallbackHandlers = new WeakSet<object>();

export function markFallbackSignalHandler(handler: (signal: NodeJS.Signals) => void): void {
  fallbackHandlers.add(handler);
}

/** Library fallback hooks do not own shutdown. */
export function hasHostSignalHandler(signal: NodeJS.Signals, exclude?: (signal: NodeJS.Signals) => void): boolean {
  return process.listeners(signal).some((handler) => handler !== exclude && !fallbackHandlers.has(handler));
}
