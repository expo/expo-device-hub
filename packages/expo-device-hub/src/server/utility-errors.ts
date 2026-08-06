import { createHash } from 'node:crypto';
import { inspect } from 'node:util';

import { type AndroidUtilsError } from '@expo/hub-android-utils';
import { type AppleUtilsError } from '@expo/hub-apple-utils';

/** A serializable utility error sent to the dashboard console. */
export interface SerializableError {
  /** Stable across repeated polls of the same failure. */
  id: string;
  message: string;
  error: string;
}

type UtilsError = AppleUtilsError | AndroidUtilsError;

export function toSerializableError(error: UtilsError | null): SerializableError | null {
  if (!error) return null;
  return {
    id: errorId(error.error),
    message: error.message,
    error: inspect(error.error, { depth: 6, breakLength: 120 }),
  };
}

/** Build an id from the standard Error identity fields. */
function errorId(error: unknown): string {
  const record = error && typeof error === 'object' ? (error as Record<string, unknown>) : null;
  const stringField = (name: string) => {
    const value = record?.[name];
    return typeof value === 'string' ? value : null;
  };

  const name = stringField('name') ?? '';
  const message = stringField('message') ?? String(error);
  const stack = stringField('stack') ?? '';
  return createHash('md5').update(name + message + stack).digest('hex');
}
