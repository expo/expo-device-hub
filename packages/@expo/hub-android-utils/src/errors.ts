import createDebug from "debug";

const debug = createDebug("expo-device-hub:android-utils");

export interface AndroidUtilsError {
  message: string;
  error: unknown;
}

export interface AndroidUtilsResult<T> {
  value: T;
  error: AndroidUtilsError | null;
}

/** Emit an informational message when the debug namespace is enabled. */
export function logDebug(message: string): void {
  debug("%s", message);
}

/** Create a utility failure and emit it when the debug namespace is enabled. */
export function reportError(message: string, error: unknown): AndroidUtilsError {
  const captured = { message, error };
  debug("%s %O", message, error);
  return captured;
}

/** Pair a utility's value with the first failure produced by that invocation. */
export function result<T>(value: T, error: AndroidUtilsError | null = null): AndroidUtilsResult<T> {
  return { value, error };
}
