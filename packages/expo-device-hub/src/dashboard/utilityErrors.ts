export interface UtilityError {
  id: string;
  message: string;
  error: string;
}

export function isUtilityError(value: unknown): value is UtilityError {
  if (!value || typeof value !== 'object') return false;
  const error = value as Record<string, unknown>;
  return (
    typeof error.id === 'string' &&
    typeof error.message === 'string' &&
    typeof error.error === 'string'
  );
}

/** Log each returned utility failure once and return the currently active ids. */
export function logUtilityErrors(
  errors: unknown,
  previouslyActive = new Set<string>()
): Set<string> {
  const nextActive = new Set<string>();
  if (!Array.isArray(errors)) return nextActive;

  for (const error of errors) {
    if (!isUtilityError(error) || nextActive.has(error.id)) continue;
    nextActive.add(error.id);
    if (!previouslyActive.has(error.id)) console.error(error.message, error.error);
  }
  return nextActive;
}
