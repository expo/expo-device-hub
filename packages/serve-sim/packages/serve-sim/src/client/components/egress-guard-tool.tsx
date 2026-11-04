import { useCallback, useEffect, useRef, useState } from "react";
import type { EgressControlStatus } from "../../egress";
import { runHostAction } from "../../socket/client-control";
import { CollapsibleSection } from "./collapsible-section";
import { SettingSwitch } from "./setting-switch";

async function requestEgress(
  action: "egress.status" | "egress.set",
  udid: string,
  enabled?: boolean,
): Promise<EgressControlStatus> {
  const result = await runHostAction(action, enabled === undefined ? { udid } : { udid, enabled });
  if (result.exitCode !== 0) throw new Error(result.stderr || "Could not update egress controls.");
  const status = JSON.parse(result.stdout) as EgressControlStatus;
  if (
    status?.available === false ||
    (status?.available === true && typeof status.enabled === "boolean")
  )
    return status;
  throw new Error("Could not read egress controls.");
}

export function EgressGuardControls({
  status,
  busy,
  error,
  onChange,
}: {
  status: EgressControlStatus | null;
  busy: boolean;
  error: string | null;
  onChange: (enabled: boolean) => void;
}) {
  return (
    <>
      <div className="flex items-center justify-between gap-3 text-xs text-white/90">
        <span>Block new external connections</span>
        <SettingSwitch
          label="Block new external connections"
          checked={status?.available === true && status.enabled}
          disabled={busy || status?.available !== true}
          onChange={onChange}
        />
      </div>
      <p className="text-[11px] leading-relaxed text-white/50">
        {status?.available === false
          ? "Egress controls are not available for this session."
          : !status
            ? error
              ? "Egress controls could not be read."
              : "Checking egress controls…"
            : "Existing connections stay open. Local connections are allowed."}
      </p>
      {busy && (
        <p role="status" className="text-[11px] text-white/50">
          Applying policy…
        </p>
      )}
      {error && (
        <p role="alert" className="text-[11px] text-red-300">
          {error}
        </p>
      )}
    </>
  );
}

export function EgressGuardTool({ udid }: { udid: string }) {
  const [open, setOpen] = useState(true);
  const [status, setStatus] = useState<EgressControlStatus | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const mounted = useRef(false);
  const pending = useRef(false);

  const refresh = useCallback(async () => {
    setBusy(true);
    try {
      const next = await requestEgress("egress.status", udid);
      if (mounted.current) {
        setStatus(next);
        setError(null);
      }
    } catch (cause) {
      if (mounted.current) setError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      if (mounted.current) setBusy(false);
    }
  }, [udid]);

  useEffect(() => {
    mounted.current = true;
    void refresh();
    return () => {
      mounted.current = false;
    };
  }, [refresh]);

  async function change(enabled: boolean) {
    if (pending.current || status?.available !== true) return;
    pending.current = true;
    setBusy(true);
    setError(null);
    try {
      await requestEgress("egress.set", udid, enabled);
    } catch (cause) {
      if (mounted.current) setError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      // Failure can publish blocking cleanup. Always read the actual policy back.
      if (mounted.current) {
        try {
          const next = await requestEgress("egress.status", udid);
          if (mounted.current) setStatus(next);
        } catch (cause) {
          if (mounted.current) {
            setStatus(null);
            setError(cause instanceof Error ? cause.message : String(cause));
          }
        }
      }
      if (mounted.current) {
        pending.current = false;
        setBusy(false);
      }
    }
  }

  return (
    <CollapsibleSection open={open} onOpenChange={setOpen} summary={<span>Egress guard</span>}>
      <EgressGuardControls
        status={status}
        busy={busy}
        error={error}
        onChange={(enabled) => void change(enabled)}
      />
      {error && !status && (
        <button type="button" disabled={busy} onClick={() => void refresh()}>
          Retry
        </button>
      )}
    </CollapsibleSection>
  );
}
