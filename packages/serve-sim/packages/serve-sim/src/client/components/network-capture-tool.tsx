import { Ban, Check, Download, Folder, Radio, Search, Settings2, TriangleAlert, X } from "lucide-react";
import { useEffect, useMemo, useState } from "react";

import {
  useCaptureStream,
  type CaptureAttachment,
  type CaptureMeta,
} from "../hooks/use-capture-stream";
import { CAPTURE_FIELDS, isCaptureField, type CaptureField } from "../../capture/fields";
import { runHostAction } from "../../socket/client-control";
import { downloadHar } from "../utils/har-download";
import { simAuthHeaders, simEndpoint } from "../utils/sim-endpoint";
import { CollapsibleSection } from "./collapsible-section";
import { Dropdown, DropdownOption } from "./select";
import { Tooltip } from "./tooltip";
import {
  DomainSection,
  RequestRow,
  formatBytes,
  groupByDomain,
  isFailedRequest,
  requestKey,
} from "./network-capture-requests";

export {
  DomainSection,
  RequestFacts,
  EmptyBodyNotice,
  RequestRow,
  TimingBar,
  formatMs,
  groupByDomain,
} from "./network-capture-requests";

type FieldChoice = { udid: string; fields: CaptureField[] } | null;

/** The panel stays mounted when the simulator changes, so a pick applies only to its own device. */
export function chosenFieldsFor(choice: FieldChoice, udid: string): CaptureField[] | null {
  return choice?.udid === udid ? choice.fields : null;
}

export function NetworkCaptureTool({ udid, captureEndpoint }: { udid: string; captureEndpoint?: string }) {
  const path = useMemo(
    () => captureEndpoint ?? `${simEndpoint("network-capture")}?device=${encodeURIComponent(udid)}`,
    [captureEndpoint, udid],
  );
  const bodyBase = useMemo(() => path.split("?")[0] ?? path, [path]);
  const harUrl = useMemo(
    () => `${bodyBase}.har?device=${encodeURIComponent(udid)}`,
    [bodyBase, udid],
  );
  const [open, setOpen] = useState(true);
  const [grouped, setGrouped] = useState(false);
  const [filter, setFilter] = useState("");
  const [changing, setChanging] = useState(false);
  const [changeError, setChangeError] = useState<string | null>(null);
  const [streamKey, setStreamKey] = useState(0);
  // The fields last picked, used by the next enable; the server's default until then.
  const [fieldChoice, setFieldChoice] = useState<FieldChoice>(null);
  const chosenFields = chosenFieldsFor(fieldChoice, udid);
  const { meta, requests, errored, clear, setMeta } = useCaptureStream(path, streamKey);
  const capturing = meta?.attachment === "capturing";
  const shownFields = capturing ? (meta?.fields ?? []) : (chosenFields ?? meta?.fields ?? []);
  const starting = meta?.attachment === "starting";
  const captureOn = capturing || starting;
  const captureButton = captureControl({ meta, errored, changing });
  const showToolbar = capturing || requests.length > 0;

  const rows = useMemo(() => {
    const needle = filter.trim().toLowerCase();
    const matched = needle
      ? requests.filter((request) => request.url.toLowerCase().includes(needle))
      : requests;
    return [...matched].reverse();
  }, [requests, filter]);

  const totals = useMemo(
    () => ({
      bytes: rows.reduce((sum, request) => sum + request.requestBytes + request.responseBytes, 0),
      failed: rows.filter(isFailedRequest).length,
    }),
    [rows],
  );
  const slowestMs = useMemo(() => Math.max(1, ...rows.map((request) => request.durationMs ?? 0)), [rows]);
  const groups = useMemo(() => (grouped ? groupByDomain(rows) : []), [grouped, rows]);

  async function toggleCapture(enable: boolean) {
    setChanging(true);
    setChangeError(null);
    try {
      const liveEnable = enable && meta?.attachment === "not-enabled";
      const fields = enable && chosenFields ? { fields: chosenFields } : {};
      const result = liveEnable
        ? await runHostAction("capture.enable", { udid, ...fields })
        : await runHostAction("capture.reboot", { udid, enabled: enable, ...fields });
      if (result.exitCode !== 0) {
        setChangeError(result.stderr || (enable ? "Capture could not be enabled." : "The simulator could not be restarted."));
        return;
      }
      setMeta(JSON.parse(result.stdout) as CaptureMeta);
      setStreamKey((key) => key + 1);
    } catch (error) {
      setChangeError(error instanceof Error ? error.message : "The capture request could not be sent.");
    } finally {
      setChanging(false);
    }
  }

  async function changeFields(next: CaptureField[]) {
    setChangeError(null);
    if (!capturing) {
      setFieldChoice({ udid, fields: next });
      return;
    }
    // Held until the reply, so a second click builds on the applied fields, not on a stale render.
    setChanging(true);
    try {
      const result = await runHostAction("capture.fields", { udid, fields: next });
      if (result.exitCode !== 0) {
        setChangeError(result.stderr || "The capture fields could not be changed.");
        return;
      }
      const changed = JSON.parse(result.stdout) as CaptureMeta;
      setMeta(changed);
      // A later restart keeps what the menu shows now, not an older pick made while capture was off.
      setFieldChoice({ udid, fields: changed.fields.filter(isCaptureField) });
    } catch (error) {
      setChangeError(error instanceof Error ? error.message : "The capture fields could not be changed.");
    } finally {
      setChanging(false);
    }
  }

  async function clearRequests() {
    setChangeError(null);
    try {
      await clear();
    } catch (error) {
      setChangeError(error instanceof Error ? error.message : "Requests could not be cleared.");
    }
  }

  const fieldsMenu = (
    <CaptureFieldsMenu
      fields={shownFields}
      disabled={meta?.attachment === "starting"}
      busy={changing}
      onChange={(next) => void changeFields(next)}
    />
  );

  return (
    <CollapsibleSection
      open={open}
      onOpenChange={setOpen}
      summaryClassName="grid [grid-template-columns:auto_1fr_auto_auto] items-center gap-2 text-left"
      summary={
        <>
          <span className="text-[11px] font-semibold text-white/50 uppercase tracking-[0.08em] leading-none inline-flex items-center">
            Network requests
          </span>
          {/* Always mounted, so a screen reader announces the text when it appears. */}
          <span className="group relative justify-self-end inline-flex items-center" role="status">
            {errored && (
              <>
                <TriangleAlert aria-hidden="true" className="w-3.5 h-3.5 text-amber-400" />
                <span className="sr-only">The capture stream disconnected</span>
                <span className="pointer-events-none absolute right-0 top-full z-10 mt-1 hidden w-max max-w-[220px] rounded-md bg-black/90 px-2 py-1 text-[11px] leading-snug text-white/90 shadow-lg group-hover:block">
                  The capture stream disconnected
                </span>
              </>
            )}
          </span>
          <span className="rounded-md border border-white/8 bg-white/[0.04] px-1.5 py-[3px] text-[10px] font-mono text-white/60">
            {rows.length}
          </span>
        </>
      }
    >
      <div className="flex flex-col gap-2">
        <div className="flex items-center gap-2">
          <span
            role="status"
            aria-label={captureStatusLabel(capturing, starting, meta?.fields)}
            className={`group relative inline-flex items-center rounded p-1 ${
              capturing
                ? "bg-emerald-500/15 text-emerald-300"
                : starting
                  ? "bg-sky-500/15 text-sky-300"
                  : "bg-amber-500/15 text-amber-300"
            }`}
          >
            <Radio aria-hidden="true" className="w-3.5 h-3.5" />
            <span className="pointer-events-none absolute left-0 top-full z-10 mt-1 hidden w-max max-w-[240px] rounded-md bg-black/90 px-2 py-1 text-[11px] leading-snug text-white/90 shadow-lg group-hover:block">
              <CaptureStatusTooltip capturing={capturing} starting={starting} fields={meta?.fields} />
            </span>
          </span>
          <button
            type="button"
            disabled={captureButton.disabled}
            onClick={() => void toggleCapture(!captureOn)}
            title={captureButton.title}
            className="rounded px-2 py-1 text-[11px] text-white/60 hover:bg-white/10 disabled:opacity-50"
          >
            {captureButton.label}
          </button>
          {/* At the row's end, where the warning's tooltip fits; the toolbar takes the menu once shown. */}
          <div className="ml-auto flex items-center gap-0.5">
            {!showToolbar && fieldsMenu}
            <CaptureFieldsWarning fields={shownFields} />
          </div>
        </div>

        {visibleChangeError(changeError, meta) && (
          <span className="whitespace-pre-line text-[11px] leading-snug text-red-300">{changeError}</span>
        )}
        {/* Remounted each time capture turns on, so the hint shows again for its full time. */}
        {capturing && <RelaunchHint />}
        <CaptureState attachment={meta?.attachment ?? "not-enabled"} attachError={meta?.attachError ?? null} />
        <OversizedBodiesNotice count={meta?.droppedOversizedBodies ?? 0} />

        {showToolbar && (
          <>
            <label className="flex h-8 items-center gap-2 rounded-lg bg-white/6 px-2.5 focus-within:bg-white/10 [transition:background_0.12s]">
              <Search aria-hidden="true" size={14} strokeWidth={2} className={`shrink-0 ${ICON_COLOR}`} />
              <input
                type="text"
                value={filter}
                onChange={(event) => setFilter(event.target.value)}
                placeholder="Filter requests"
                aria-label="Filter requests by URL"
                className="min-w-0 flex-1 border-none bg-transparent text-[12px] text-white/90 outline-none placeholder:text-white/40"
              />
              {filter && (
                <button
                  type="button"
                  aria-label="Clear filter"
                  onClick={() => setFilter("")}
                  className={`grid size-4 shrink-0 place-items-center rounded-full bg-white/15 hover:bg-white/25 ${ICON_COLOR}`}
                >
                  <X aria-hidden="true" size={9} strokeWidth={3} />
                </button>
              )}
            </label>

            <div className="flex items-center justify-end gap-0.5">
              <Tooltip label="Group by domain" align="right">
                <button
                  type="button"
                  aria-label="Group by domain"
                  aria-pressed={grouped}
                  onClick={() => setGrouped((on) => !on)}
                  className={`${TOOLBAR_BUTTON} ${grouped ? "text-accent" : ICON_COLOR}`}
                >
                  <Folder aria-hidden="true" size={14} strokeWidth={1.75} />
                </button>
              </Tooltip>
              {fieldsMenu}
              <span aria-hidden="true" className="mx-1 h-4 w-px bg-white/10" />
              <Tooltip label="Download session as HAR" align="right">
                <button
                  type="button"
                  aria-label="Download session as HAR"
                  className={`${TOOLBAR_BUTTON} ${ICON_COLOR}`}
                  onClick={() => {
                    setChangeError(null);
                    // Closing the save picker resolves quietly; a failed fetch or write is shown.
                    void downloadHar(harUrl, `serve-sim-${udid.slice(0, 8)}.har`, simAuthHeaders()).catch((error) => {
                      setChangeError(error instanceof Error ? error.message : "The HAR could not be downloaded.");
                    });
                  }}
                >
                  <Download aria-hidden="true" size={14} strokeWidth={1.75} />
                </button>
              </Tooltip>
              <Tooltip label="Clear the live request list (the session HAR on disk is kept)" align="right">
                <button
                  type="button"
                  aria-label="Clear the live request list"
                  onClick={() => void clearRequests()}
                  className={`${TOOLBAR_BUTTON} ${ICON_COLOR}`}
                >
                  <Ban aria-hidden="true" size={14} strokeWidth={1.75} />
                </button>
              </Tooltip>
            </div>

            <div className="thin-scroll max-h-64 overflow-y-auto pr-1.5 border-t border-white/5">
              {rows.length === 0 ? (
                <span className="block py-2 text-[11px] text-white/40">
                  {filter ? "No requests match that filter." : "No requests captured yet."}
                </span>
              ) : grouped ? (
                groups.map((group) => (
                  <DomainSection
                    key={group.host}
                    group={group}
                    udid={udid}
                    slowestMs={slowestMs}
                  />
                ))
              ) : (
                rows.map((request) => (
                  <RequestRow
                    key={requestKey(request)}
                    request={request}
                    udid={udid}
                    slowestMs={slowestMs}
                  />
                ))
              )}
            </div>

            <div className="border-t border-white/5 pt-1.5 text-[11px] text-white/40 tabular-nums">
              {grouped && `${groups.length} domain${groups.length === 1 ? "" : "s"} · `}
              {rows.length} request{rows.length === 1 ? "" : "s"} · {formatBytes(totals.bytes)}
              {totals.failed > 0 && <span className="text-red-400/80"> · {totals.failed} failed</span>}
            </div>
          </>
        )}
      </div>
    </CollapsibleSection>
  );
}

const FIELD_LABELS: Record<CaptureField, string> = {
  header: "Headers",
  query: "Query values",
  "request-body": "Request bodies",
  "response-body": "Response bodies",
};

/** `fields` with `field` switched, in the proxy's order. */
export function toggleField(fields: readonly string[], field: CaptureField): CaptureField[] {
  const on = new Set(fields);
  return CAPTURE_FIELDS.filter((each) => (each === field ? !on.has(each) : on.has(each)));
}

/**
 * What capture keeps beyond method, URL, status, timing, and size. While a change is in flight the
 * menu ignores clicks, so the next click builds on the applied fields.
 */
export function CaptureFieldsMenu({
  fields,
  disabled,
  busy,
  onChange,
}: {
  fields: readonly string[];
  disabled: boolean;
  busy: boolean;
  onChange: (next: CaptureField[]) => void;
}) {
  const on = new Set(fields);
  return (
    <Tooltip label="What capture keeps" align="right">
      <Dropdown
        label="What capture keeps"
        multiple
        disabled={disabled}
        className={`${TOOLBAR_BUTTON} ${ICON_COLOR}`}
        trigger={<Settings2 aria-hidden="true" size={14} strokeWidth={1.75} />}
      >
        {CAPTURE_FIELDS.map((field) => (
          <DropdownOption key={field} selected={on.has(field)} onClick={() => { if (!busy) onChange(toggleField(fields, field)); }}>
            <span className="inline-flex items-center gap-2">
              <Check aria-hidden="true" className={`w-3 h-3 ${on.has(field) ? "" : "invisible"}`} />
              {FIELD_LABELS[field]}
            </span>
          </DropdownOption>
        ))}
      </Dropdown>
    </Tooltip>
  );
}

/** Solid, not translucent: serve-sim avoids low-opacity icons. Matches the logs drawer. */
const ICON_COLOR = "text-[#8e8e93]";

/** The icon buttons in the toolbar, matching the logs drawer's. */
const TOOLBAR_BUTTON =
  "flex h-6 w-6 items-center justify-center rounded hover:bg-white/8 hover:text-white disabled:opacity-50 disabled:hover:bg-transparent";

const CREDENTIALS_WARNING = "Headers and bodies can hold credentials and cookies, and are kept in the recording.";

/** Shown while headers or bodies are kept, since they can hold credentials. */
export function CaptureFieldsWarning({ fields }: { fields: readonly string[] }) {
  if (!fields.some((field) => field !== "query")) return null;
  return (
    <Tooltip label={CREDENTIALS_WARNING} align="right">
      {/* Focusable, so a keyboard user can open the tooltip too. */}
      <span
        tabIndex={0}
        role="img"
        aria-label={CREDENTIALS_WARNING}
        className="flex h-6 w-6 items-center justify-center rounded text-amber-400 outline-none focus-visible:ring-1 focus-visible:ring-white/40"
      >
        <TriangleAlert aria-hidden="true" size={14} strokeWidth={1.75} />
      </span>
    </Tooltip>
  );
}

/**
 * The action's error, unless it is exactly the enable action's report of the failed start the
 * capture state already shows ("Could not enable network capture: <reason>"). Any other error, such
 * as a restart that failed with the same reason, keeps its own message and recovery advice.
 */
export function visibleChangeError(changeError: string | null, meta: CaptureMeta | null): string | null {
  if (!changeError) return null;
  const repeatsFailedStart = meta?.attachment === "failed" && !!meta.attachError &&
    changeError === `Could not enable network capture: ${meta.attachError}`;
  return repeatsFailedStart ? null : changeError;
}

const RELAUNCH_HINT_MS = 10_000;

/** Shown once capture is on: an app that was already open keeps its old connections. */
export function RelaunchHint() {
  const [visible, setVisible] = useState(true);
  useEffect(() => {
    const timer = setTimeout(() => setVisible(false), RELAUNCH_HINT_MS);
    return () => clearTimeout(timer);
  }, []);
  if (!visible) return null;
  return (
    <span className="text-[11px] leading-snug text-white/40">
      Relaunch apps that were already open to capture their requests.
    </span>
  );
}

export function captureControl({
  meta,
  errored,
  changing,
}: {
  meta: CaptureMeta | null;
  errored: boolean;
  changing: boolean;
}): { disabled: boolean; label: string; title?: string } {
  if (changing) return { disabled: true, label: "Working…" };
  if (meta === null) {
    return errored
      ? { disabled: false, label: "Restart with capture" }
      : { disabled: true, label: "Enable capture" };
  }
  if (meta.attachment === "starting") return { disabled: true, label: "Starting…" };
  if (meta.attachment === "capturing") {
    return {
      disabled: false,
      label: "Turn off and restart",
      title: "Restarts the simulator so running apps stop using the capture proxy.",
    };
  }
  return { disabled: false, label: meta.attachment === "failed" ? "Restart with capture" : "Enable capture" };
}

export function CaptureState({
  attachment,
  attachError,
}: {
  attachment: CaptureAttachment;
  attachError: string | null;
}) {
  if (attachment === "capturing") return null;
  if (attachment === "failed") {
    return (
      <span className="whitespace-pre-line text-[11px] leading-snug text-amber-400/80">
        {attachError ?? "Capture could not start."}
      </span>
    );
  }
  if (attachment === "starting") {
    return <span className="text-[11px] text-white/40">Starting capture on this device…</span>;
  }
  return attachError ? (
    <span className="whitespace-pre-line text-[11px] leading-snug text-white/40">{attachError}</span>
  ) : null;
}

function responseBodiesEnabled(fields: string[] | undefined): boolean {
  return !!fields?.includes("response-body");
}

export function captureStatusLabel(
  capturing: boolean,
  starting: boolean,
  fields: string[] | undefined,
): string {
  if (starting) return "Capture starting";
  if (!capturing) return "Capture disabled";
  if (responseBodiesEnabled(fields)) return "Capture enabled";
  return "Capture enabled. Response bodies not captured.";
}

export function CaptureStatusTooltip({
  capturing,
  starting,
  fields,
}: {
  capturing: boolean;
  starting: boolean;
  fields: string[] | undefined;
}) {
  if (starting) return <>Capture starting</>;
  if (!capturing) return <>Capture disabled</>;
  if (responseBodiesEnabled(fields)) return <>Capture enabled</>;
  return (
    <>
      Capture enabled
      <span className="mt-0.5 block text-white/55">Response bodies not captured</span>
    </>
  );
}

export function OversizedBodiesNotice({ count }: { count: number }) {
  if (count <= 0) return null;
  return (
    <span className="flex items-start gap-1.5 text-[11px] leading-snug text-amber-400/80">
      <TriangleAlert aria-hidden="true" className="mt-0.5 h-3 w-3 shrink-0" />
      Dropped {count} oversized capture post{count === 1 ? "" : "s"} (over the control-body limit).
      Check the serve-sim terminal for `[capture] Dropped oversized control body`, or raise{" "}
      <code className="text-amber-300/90">SERVE_SIM_CAPTURE_MAX_CONTROL_BODY_BYTES</code>.
    </span>
  );
}
