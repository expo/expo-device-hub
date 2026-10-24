import { useCallback, useEffect, useRef, useState, type ReactNode } from "react";
import { Check, X } from "lucide-react";
import { ReloadIcon } from "../icons";
import { runHostAction } from "../../socket/client-control";
import { CollapsibleSection } from "./collapsible-section";
import { PERMISSION_SERVICES, type PermAction, type PermState } from "../utils/permissions";

export function AppPermissionsTool({ udid, bundleId }: { udid: string; bundleId: string | null }) {
  const [state, setState] = useState<PermState>({});
  const targetKey = JSON.stringify([udid, bundleId]);
  const [pendingWrites, setPendingWrites] = useState<Record<string, string>>({});
  const pending = pendingWrites[targetKey] ?? null;
  const [readError, setReadError] = useState<string | null>(null);
  const [writeError, setWriteError] = useState<string | null>(null);
  const error = writeError ?? readError;
  const [open, setOpen] = useState(false);

  const generation = useRef(0);
  const reading = useRef(new Set<string>());
  const writing = useRef(new Set<string>());
  const refresh = useCallback(
    async (force = false) => {
      const own = generation.current;
      const readKey = `${targetKey}:${own}`;
      if (!bundleId || (!force && (reading.current.has(readKey) || writing.current.has(targetKey))))
        return;
      reading.current.add(readKey);
      try {
        const res = await runHostAction("permissions.list", { bundleId, udid });
        if (res.exitCode !== 0) throw new Error(res.stderr.trim() || "Could not read permissions");
        const payload = JSON.parse(res.stdout);
        if (
          !Array.isArray(payload.permissions) ||
          !payload.permissions.every(
            (p: any) =>
              typeof p.id === "string" &&
              ["granted", "denied", "limited", "undetermined"].includes(p.state),
          )
        )
          throw new Error("Invalid permissions response");
        if (own !== generation.current) return;
        const next: PermState = {};
        for (const permission of payload.permissions) {
          next[permission.id] =
            permission.state === "granted"
              ? "grant"
              : permission.state === "denied"
                ? "revoke"
                : permission.state === "limited"
                  ? "limited"
                  : "reset";
        }
        // When-in-use does not imply always authorization.
        next["location-always"] =
          payload.location?.Authorization === 4
            ? "grant"
            : payload.location?.Authorization === 1
              ? "revoke"
              : payload.location?.Authorization == null || payload.location.Authorization === 0
                ? "reset"
                : undefined;
        setState(next);
        setReadError(null);
      } catch (e) {
        if (own === generation.current) {
          setState({});
          setReadError(e instanceof Error ? e.message : String(e));
        }
      } finally {
        reading.current.delete(readKey);
      }
    },
    [bundleId, udid, targetKey],
  );

  const latestTarget = useRef<{ key: string; refresh: typeof refresh } | null>(null);
  useEffect(() => {
    latestTarget.current = { key: targetKey, refresh };
    const retire = () => {
      latestTarget.current = null;
    };
    return retire;
  }, [targetKey, refresh]);

  useEffect(() => {
    generation.current++;
    setState({});
    setReadError(null);
    setWriteError(null);
    if (!open) return;
    void refresh(true);
    const timer = setInterval(() => void refresh(), 5000);
    const focus = () => void refresh();
    window.addEventListener("focus", focus);
    const invalidate = () => {
      generation.current++;
    };
    return () => {
      invalidate();
      clearInterval(timer);
      window.removeEventListener("focus", focus);
    };
  }, [bundleId, udid, open, refresh]);

  const write = useCallback(
    async (key: string, run: () => ReturnType<typeof runHostAction>) => {
      if (!bundleId || writing.current.has(targetKey)) return;
      writing.current.add(targetKey);
      generation.current++;
      setPendingWrites((previous) => ({ ...previous, [targetKey]: key }));
      setReadError(null);
      setWriteError(null);
      try {
        const result = await run();
        if (result.exitCode !== 0)
          throw new Error(result.stderr.trim() || "Could not change permissions");
      } catch (error) {
        if (latestTarget.current?.key === targetKey)
          setWriteError(error instanceof Error ? error.message : String(error));
      } finally {
        const current = latestTarget.current;
        if (current?.key === targetKey) {
          generation.current++;
          await current.refresh(true);
        }
        writing.current.delete(targetKey);
        if (latestTarget.current)
          setPendingWrites((previous) => {
            const next = { ...previous };
            delete next[targetKey];
            return next;
          });
      }
    },
    [bundleId, targetKey],
  );

  const apply = (service: string, action: PermAction) =>
    write(`${service}:${action}`, () =>
      runHostAction("permissions.set", { action, service, bundleId: bundleId!, udid }),
    );
  const resetAll = () =>
    write("__all__", () => runHostAction("permissions.resetAll", { bundleId: bundleId!, udid }));

  if (!bundleId) {
    return <AppPermissionsLoading />;
  }

  return (
    <CollapsibleSection
      open={open}
      onOpenChange={setOpen}
      summaryClassName="grid [grid-template-columns:auto_1fr_auto] items-center gap-2 text-left"
      summary={
        <>
          <span className="text-[11px] font-semibold text-white/50 uppercase tracking-[0.08em] leading-none inline-flex items-center">
            Permissions
          </span>
          <span />
        </>
      }
    >
      {error && (
        <div className="bg-danger/10 border border-danger/20 text-danger-soft text-[11px] px-2 py-1.5 rounded-md">
          {error}
        </div>
      )}

      <p className="text-[11px] text-white/60 py-1">
        Shows service authorization. Some apps cache status until relaunch. Notifications may need
        the app’s normal request to enable alerts.
      </p>
      <div className="relative">
        <div className="max-h-[260px] overflow-y-auto flex flex-col gap-1 py-2 [scrollbar-width:thin]">
          {PERMISSION_SERVICES.map(({ key, label }) => {
            const current = state[key];
            return (
              <div key={key} className="flex items-center justify-between gap-2 px-0.5 py-1">
                <span className="text-[12px] text-white/90 overflow-hidden text-ellipsis whitespace-nowrap flex-1 min-w-0">
                  {label}
                  {current === "limited" && <span className="ml-2 text-[10px]">Limited</span>}
                </span>
                <div
                  className="flex gap-0.5 bg-white/[0.04] border border-white/8 rounded-md p-0.5"
                  role="group"
                  aria-label={label}
                >
                  <PermBtn
                    active={current === "grant"}
                    disabled={pending !== null}
                    pending={pending === `${key}:grant`}
                    onClick={() => apply(key, "grant")}
                    variant="grant"
                    title="Allow"
                  >
                    <Check size={11} strokeWidth={3} />
                  </PermBtn>
                  <PermBtn
                    active={current === "revoke"}
                    disabled={pending !== null}
                    pending={pending === `${key}:revoke`}
                    onClick={() => apply(key, "revoke")}
                    variant="revoke"
                    title="Deny"
                  >
                    <X size={11} strokeWidth={3} />
                  </PermBtn>
                  <PermBtn
                    active={current === "reset"}
                    disabled={pending !== null}
                    pending={pending === `${key}:reset`}
                    onClick={() => apply(key, "reset")}
                    variant="reset"
                    title="Reset"
                  >
                    <ReloadIcon size={11} strokeWidth={2.4} />
                  </PermBtn>
                </div>
              </div>
            );
          })}
        </div>
        <div className="absolute top-0 left-0 right-0 h-[14px] pointer-events-none rounded-t-[10px] bg-[linear-gradient(to_bottom,#1c1c1e_0%,rgba(28,28,30,0)_100%)]" />
        <div className="absolute bottom-0 left-0 right-0 h-[14px] pointer-events-none bg-[linear-gradient(to_top,#1c1c1e_0%,rgba(28,28,30,0)_100%)]" />
      </div>

      <div className="flex justify-end">
        <button
          onClick={resetAll}
          disabled={pending !== null}
          className="bg-transparent border border-white/12 text-white/70 text-[10px] px-2 py-[3px] rounded-[5px] cursor-pointer uppercase tracking-[0.04em]"
          title="serve-sim permissions reset all"
        >
          {pending === "__all__" ? "…" : "Reset all"}
        </button>
      </div>
    </CollapsibleSection>
  );
}

export function AppPermissionsLoading() {
  return (
    <div
      data-testid="app-permissions-loading"
      className="bg-panel rounded-[10px] px-3 py-2"
      aria-disabled="true"
      aria-busy="true"
    >
      <div className="select-none text-white/55 min-h-[36px] leading-none py-2.5 px-1 -my-2 -mx-1 w-[calc(100%+8px)] grid [grid-template-columns:auto_1fr_auto] items-center gap-2 text-left cursor-default">
        <span className="text-[11px] font-semibold uppercase tracking-[0.08em] leading-none inline-flex items-center">
          Permissions
        </span>
        <span />
        <span
          data-testid="permissions-loading-indicator"
          role="status"
          aria-label="Loading permissions"
          className="size-2.5 rounded-full border border-[#5f6268] border-t-[#f4f4f5] animate-[grid-spin_0.7s_linear_infinite]"
        />
      </div>
    </div>
  );
}

function PermBtn({
  active,
  pending,
  disabled,
  onClick,
  variant,
  title,
  children,
}: {
  active: boolean;
  pending: boolean;
  disabled: boolean;
  onClick: () => void;
  variant: "grant" | "revoke" | "reset";
  title: string;
  children: ReactNode;
}) {
  const accent = variant === "grant" ? "#4ade80" : variant === "revoke" ? "#f87171" : "#a5b4fc";
  return (
    <button
      onClick={onClick}
      disabled={disabled}
      aria-pressed={active}
      title={title}
      aria-label={title}
      className="w-6 h-5.5 flex items-center justify-center border-none rounded p-0 cursor-pointer [transition:background_0.12s,color_0.12s]"
      style={{
        background: active ? `${accent}22` : "transparent",
        color: active ? accent : "rgba(255,255,255,0.55)",
        opacity: pending ? 0.5 : 1,
      }}
    >
      {children}
    </button>
  );
}
