import { type AppPermission, type AppPermissionAction } from "./types";

/** One platform's permission transport. Every call resolves to the fresh list. */
export interface PermissionsBackend {
  list(appId: string): Promise<AppPermission[]>;
  write(appId: string, id: string, action: AppPermissionAction): Promise<AppPermission[]>;
  reset(appId: string): Promise<AppPermission[]>;
}

export type PermissionsFetch = (input: string, init?: RequestInit) => Promise<Response>;

/** Shared empty set so a client with no permission writes keeps a stable identity across renders. */
export const NO_PENDING_PERMISSION_WRITES: ReadonlySet<string> = new Set();

export function asRecord(value: unknown): Record<string, unknown> | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  return value as Record<string, unknown>;
}

/** `ACCESS_FINE_LOCATION` and `photos-add` both read as sentence case. */
export function humanize(name: string): string {
  const words = name.toLowerCase().replace(/[_-]+/g, " ").trim();
  return words.charAt(0).toUpperCase() + words.slice(1);
}

function errorMessage(payload: unknown, fallback: string): string {
  const error = asRecord(payload)?.error;
  return typeof error === "string" && error ? error : fallback;
}

/** Parse a backend reply, or throw with the backend's `error` text. */
export async function readPermissions(
  response: Response,
  parse: (payload: unknown) => AppPermission[] | null,
  fallback: string,
): Promise<AppPermission[]> {
  const payload: unknown = await response.json().catch(() => null);
  const permissions = response.ok ? parse(payload) : null;
  if (permissions) return permissions;
  throw new Error(errorMessage(payload, fallback));
}

export type PermissionWriteVersions = Readonly<Record<string, number>>;

/**
 * Ids a list result may not overwrite: a write is still pending, or one
 * started after the request began. The request's own ids stay authoritative.
 */
export function stalePermissionIds(
  pending: ReadonlySet<string>,
  versionsAtStart: PermissionWriteVersions,
  versionsNow: PermissionWriteVersions,
  ownIds: readonly string[],
): ReadonlySet<string> {
  const held = new Set(pending);
  for (const id of Object.keys(versionsNow)) {
    if (versionsNow[id] !== versionsAtStart[id]) held.add(id);
  }
  for (const id of ownIds) held.delete(id);
  return held;
}

export function applyPermissionsRead(
  current: readonly AppPermission[] | null,
  next: readonly AppPermission[],
  held: ReadonlySet<string>,
): readonly AppPermission[] {
  if (!current || held.size === 0) return next;
  return next.map((permission) =>
    held.has(permission.id)
      ? (current.find((item) => item.id === permission.id) ?? permission)
      : permission,
  );
}
