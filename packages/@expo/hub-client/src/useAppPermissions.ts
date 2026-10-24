import { useCallback, useMemo, useRef, useState } from "react";

import {
  applyPermissionsRead,
  NO_PENDING_PERMISSION_WRITES,
  type PermissionsBackend,
  type PermissionWriteVersions,
  heldPermissionIds,
} from "./app-permissions";
import { type AppPermission, type AppPermissionAction } from "./types";

interface UseAppPermissionsOptions {
  active: boolean;
  appId: string | null;
  backend: PermissionsBackend | null;
  targetId: string | null;
}
type Write = { needsReadback: boolean };
function createTargetState() {
  return {
    writes: new Map<string, Write>(),
    versions: {} as PermissionWriteVersions,
    backend: null as PermissionsBackend | null,
    generation: 0,
    read: null as object | null,
    permissions: null as readonly AppPermission[] | null,
    readError: null as string | null,
    writeError: null as string | null,
  };
}
type TargetState = ReturnType<typeof createTargetState>;
type Target = { appId: string; state: TargetState };
function applyRead(
  state: TargetState,
  next: AppPermission[],
  generation: number,
  versions: PermissionWriteVersions,
  pending: ReadonlySet<string>,
  ownIds: readonly string[],
) {
  if (state.generation !== generation) return false;
  state.permissions = applyPermissionsRead(
    state.permissions,
    next,
    heldPermissionIds(
      new Set([...pending, ...state.writes.keys()]),
      versions,
      state.versions,
      ownIds,
    ),
  );
  state.readError = null;
  return true;
}

export function useAppPermissions({ active, backend, appId, targetId }: UseAppPermissionsOptions) {
  // @ref LLP 0013#app-permissions — retain ownership until authoritative readback, including after disconnects
  const states = useRef(new Map<string, TargetState>());
  const [, render] = useState(0);
  const target = useMemo(() => {
    if (!active || !backend || !appId || !targetId) return null;
    const key = JSON.stringify([targetId, appId]);
    let state = states.current.get(key);
    if (!state) {
      state = createTargetState();
      states.current.set(key, state);
    }
    if (state.backend !== backend) {
      state.backend = backend;
      state.generation++;
      state.read = null;
      state.permissions = null;
      state.readError = null;
    }
    for (const [otherKey, other] of states.current)
      if (otherKey !== key && other.writes.size === 0) states.current.delete(otherKey);
    return { appId, state };
  }, [active, backend, appId, targetId]);
  const targetRef = useRef(target);
  targetRef.current = target;
  const publish = useCallback((state: TargetState) => {
    if (targetRef.current?.state === state) render((version) => version + 1);
  }, []);

  const refreshTarget = useCallback(
    async function refreshTarget({ appId, state }: Target): Promise<void> {
      if (state.read || !state.backend) return;
      const token = {};
      state.read = token;
      const generation = state.generation;
      const versions = state.versions;
      const pending = new Set(state.writes.keys());
      const recovering = new Map([...state.writes].filter(([, write]) => write.needsReadback));
      try {
        const next = await state.backend.list(appId);
        if (applyRead(state, next, generation, versions, pending, [...recovering.keys()])) {
          for (const [id, write] of recovering)
            if (state.writes.get(id) === write) state.writes.delete(id);
          publish(state);
        }
      } catch (error) {
        if (generation === state.generation) {
          state.readError = error instanceof Error ? error.message : "Permission read failed";
          publish(state);
        }
      } finally {
        if (state.read === token) {
          state.read = null;
          // A write may have lost its reply while this earlier read was pending.
          if ([...state.writes].some(([id, write]) => write.needsReadback && !recovering.has(id)))
            void refreshTarget({ appId, state });
        }
      }
    },
    [publish],
  );

  const write = useCallback(
    (
      ids: readonly string[],
      run: (backend: PermissionsBackend, app: string) => Promise<AppPermission[]>,
    ) => {
      if (!target || !target.state.backend || ids.length === 0) return;
      const { state, appId } = target;
      if (ids.some((id) => state.writes.has(id))) return;
      const tokens = new Map(ids.map((id) => [id, { needsReadback: false }]));
      for (const [id, token] of tokens) state.writes.set(id, token);
      const versions = { ...state.versions };
      for (const id of ids) versions[id] = (versions[id] ?? 0) + 1;
      state.versions = versions;
      const generation = state.generation;
      const pending = new Set(state.writes.keys());
      state.readError = null;
      state.writeError = null;
      publish(state);
      void (async () => {
        let confirmed = false;
        try {
          const next = await run(state.backend!, appId);
          confirmed = applyRead(state, next, generation, versions, pending, ids);
        } catch (error) {
          state.writeError = error instanceof Error ? error.message : "Permission request failed";
        }
        for (const [id, token] of tokens) {
          if (state.writes.get(id) !== token) continue;
          if (confirmed) state.writes.delete(id);
          else token.needsReadback = true;
        }
        publish(state);
        // The host orders this read after native work even if the original socket closed.
        // A failed read keeps controls pending until a later refresh confirms the result.
        if (!confirmed) void refreshTarget(target);
      })();
    },
    [target, publish, refreshTarget],
  );

  const setPermission = useCallback(
    (id: string, action: AppPermissionAction) =>
      write([id], (current, app) => current.write(app, id, action)),
    [write],
  );
  const permissions = target?.state.permissions ?? null;
  const resetPermissions = useCallback(
    () =>
      write(
        (permissions ?? []).map((permission) => permission.id),
        (current, app) => current.reset(app),
      ),
    [write, permissions],
  );
  const refreshPermissions = useCallback(() => {
    if (target) void refreshTarget(target);
  }, [target, refreshTarget]);
  return {
    permissions,
    permissionsPending: target ? new Set(target.state.writes.keys()) : NO_PENDING_PERMISSION_WRITES,
    permissionsError: target ? (target.state.writeError ?? target.state.readError) : null,
    setPermission,
    resetPermissions,
    refreshPermissions,
  };
}
