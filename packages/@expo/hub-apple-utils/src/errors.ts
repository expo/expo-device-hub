import createDebug from "debug";

const debug = createDebug("expo-device-hub:apple-utils");

export interface AppleUtilsError {
  message: string;
  error: unknown;
}

export interface AppleUtilsResult<T> {
  value: T;
  error: AppleUtilsError | null;
}

/** Create a utility failure and emit it when the debug namespace is enabled. */
export function reportError(message: string, error: unknown): AppleUtilsError {
  const captured = { message, error };
  debug("%s %O", message, error);
  return captured;
}

/** Pair a utility's value with the first failure produced by that invocation. */
export function result<T>(value: T, error: AppleUtilsError | null = null): AppleUtilsResult<T> {
  return { value, error };
}
