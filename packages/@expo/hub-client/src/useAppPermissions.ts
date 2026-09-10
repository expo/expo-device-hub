import { useCallback, useEffect, useMemo, useRef, useState } from "react";

import {
  applyPermissionsRead,
  NO_PENDING_PERMISSION_WRITES,
  type PermissionsBackend,
  type PermissionWriteVersions,
  stalePermissionIds,
} from "./app-permissions";
import { KeyedWriteTracker } from "./keyed-write-tracker";
import { type AppPermission, type AppPermissionAction } from "./types";

interface UseAppPermissionsOptions {
  active: boolean;
  /** Foreground app id. A change discards in-flight results and clears the list. */
  appId: string | null;
  backend: PermissionsBackend | null;
}

type ListRequest = (backend: PermissionsBackend, appId: string) => Promise<AppPermission[]>;

/**
 * Permissions of the foreground app. Nothing reads on a timer: the section
 * calls `refreshPermissions` when it opens, and every write reads the list back.
 */
export function useAppPermissions({ active, backend, appId }: UseAppPermissionsOptions) {
  const [permissions, setPermissions] = useState<readonly AppPermission[] | null>(null);
  const [permissionsPending, setPermissionsPending] = useState<ReadonlySet<string>>(
    NO_PENDING_PERMISSION_WRITES,
  );
  const [permissionsError, setPermissionsError] = useState<string | null>(null);
  const trackerRef = useRef(new KeyedWriteTracker<string>());
  const versionsRef = useRef<PermissionWriteVersions>({});
  const target = useMemo(
    () => (active && backend && appId ? { backend, appId } : null),
    [active, backend, appId],
  );
  const targetRef = useRef(target);

  useEffect(() => {
    targetRef.current = target;
    trackerRef.current.reset();
    versionsRef.current = {};
    setPermissions(null);
    setPermissionsPending(NO_PENDING_PERMISSION_WRITES);
    setPermissionsError(null);
  }, [target]);

  const publishPending = (tracker: KeyedWriteTracker<string>) => {
    const pending = tracker.pending;
    setPermissionsPending(pending.size === 0 ? NO_PENDING_PERMISSION_WRITES : pending);
  };

  const request = useCallback(
    (ownIds: readonly string[], run: ListRequest): Promise<void> => {
      if (!target) return Promise.resolve();
      const tracker = trackerRef.current;
      const versionsAtStart = versionsRef.current;
      return run(target.backend, target.appId).then(
        (next) => {
          if (target !== targetRef.current) return;
          const held = stalePermissionIds(
            tracker.pending,
            versionsAtStart,
            versionsRef.current,
            ownIds,
          );
          setPermissions((current) => applyPermissionsRead(current, next, held));
          setPermissionsError(null);
        },
        (error: unknown) => {
          if (target !== targetRef.current) return;
          setPermissionsError(error instanceof Error ? error.message : "Permission request failed");
        },
      );
    },
    [target],
  );

  const write = useCallback(
    (ids: readonly string[], run: ListRequest) => {
      const tracker = trackerRef.current;
      const pending = tracker.pending;
      if (ids.length === 0 || ids.some((id) => pending.has(id))) return;
      const tokens = ids.flatMap((id) => {
        const token = tracker.start(id);
        return token ? [token] : [];
      });
      const versions = { ...versionsRef.current };
      for (const id of ids) versions[id] = (versions[id] ?? 0) + 1;
      versionsRef.current = versions;
      setPermissionsError(null);
      publishPending(tracker);
      void request(ids, run).finally(() => {
        let changed = false;
        for (const token of tokens) changed = tracker.finish(token) || changed;
        if (changed) publishPending(tracker);
      });
    },
    [request],
  );

  const setPermission = useCallback(
    (id: string, action: AppPermissionAction) =>
      write([id], (current, app) => current.write(app, id, action)),
    [write],
  );

  const resetPermissions = useCallback(
    () =>
      write(
        (permissions ?? []).map((permission) => permission.id),
        (current, app) => current.reset(app),
      ),
    [write, permissions],
  );

  const refreshPermissions = useCallback(() => {
    void request([], (current, app) => current.list(app));
  }, [request]);

  return {
    permissions,
    permissionsPending,
    permissionsError,
    setPermission,
    resetPermissions,
    refreshPermissions,
  };
}
