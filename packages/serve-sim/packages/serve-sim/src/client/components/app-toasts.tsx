import { Check, ChevronRight, CircleAlert, Copy, X } from "lucide-react";
import { useEffect, useId, useRef, useState } from "react";
import { Toaster, toast } from "sonner";
import type { ClipboardToast } from "../hooks/use-clipboard-toast";
import { useCoarsePointer } from "../hooks/use-coarse-pointer";
import type { UploadToast } from "../hooks/use-upload-toasts";
import { copyTextToClipboard } from "../utils/share-link";
import { installToastHoverGuard } from "../utils/toast-hover";
import { describeUploadError } from "../utils/upload-error";

const INPUT_SOCKET_ERROR_TOAST_ID = "simulator-input-error";

export function ServeSimToaster() {
  const ref = useRef<HTMLElement>(null);
  useEffect(() => {
    if (ref.current) return installToastHoverGuard(ref.current);
  }, []);

  return (
    <Toaster
      ref={ref}
      theme="dark"
      position="bottom-center"
      visibleToasts={4}
      gap={8}
      offset={{ bottom: 24 }}
      toastOptions={{ unstyled: true }}
      style={{ zIndex: 2147483647 }}
      containerAriaLabel="serve-sim notifications"
    />
  );
}

export function showInputSocketError(reason: string): void {
  toast.custom(
    () => (
      <div
        role="alert"
        className="max-w-[320px] rounded-md border border-white/12 bg-panel px-3 py-2 font-mono text-[12px] text-white shadow-lg"
      >
        Simulator input failed: {reason}
      </div>
    ),
    { id: INPUT_SOCKET_ERROR_TOAST_ID },
  );
}

export function dismissInputSocketError(): void {
  toast.dismiss(INPUT_SOCKET_ERROR_TOAST_ID);
}

export function UploadToastContent({
  toast,
  onDismiss,
}: {
  toast: UploadToast;
  onDismiss?: () => void;
}) {
  if (toast.status === "error") return <UploadErrorContent toast={toast} onDismiss={onDismiss} />;
  const isUploading = toast.status === "uploading";
  const transferring = isUploading && toast.progress !== null;
  const pct = toast.progress != null ? Math.round(toast.progress * 100) : 0;

  return (
    <div
      data-testid="upload-toast"
      className="flex w-[min(320px,calc(100vw-32px))] flex-col gap-1.5 px-3 py-2 bg-panel border border-white/12 rounded-lg text-white/90 text-[12px] font-mono shadow-[0_8px_24px_rgba(0,0,0,0.45)] select-none cursor-default"
    >
      <div className="flex items-center gap-2 min-w-0">
        <span
          className="size-1.5 rounded-full shrink-0 [transition:background_0.3s]"
          style={{
            background:
              toast.status === "success"
                ? "#4ade80"
                : isUploading
                  ? "#a5b4fc"
                  : "rgba(255,255,255,0.35)",
          }}
        />
        <span className="flex-1 overflow-hidden text-ellipsis whitespace-nowrap">
          {toast.status === "queued" && `Waiting to upload ${toast.name}…`}
          {isUploading && transferring && `Uploading ${toast.name}… ${pct}%`}
          {isUploading &&
            !transferring &&
            (toast.kind === "app" ? `Installing ${toast.name}…` : `Adding ${toast.name}…`)}
          {toast.status === "success" &&
            (toast.kind === "app" ? `Installed ${toast.name}` : `Added ${toast.name} to Photos`)}
        </span>
      </div>
      {isUploading && (
        <div className="relative h-[3px] w-full bg-white/8 rounded-[2px] overflow-hidden">
          {transferring ? (
            <div
              className="h-full bg-accent rounded-[2px] [transition:width_120ms_linear]"
              style={{ width: `${pct}%` }}
            />
          ) : (
            <div className="serve-sim-toast-indeterminate absolute top-0 left-0 h-full w-[40%] bg-accent rounded-[2px]" />
          )}
        </div>
      )}
    </div>
  );
}

// An error stays until dismissed: a title that names the file, then what to do next.
function UploadErrorContent({ toast, onDismiss }: { toast: UploadToast; onDismiss?: () => void }) {
  const { title, body, details } = describeUploadError(toast.name, toast.kind, toast.message);
  const [open, setOpen] = useState(false);
  const [copied, setCopied] = useState(false);
  const detailsId = useId();
  useEffect(() => {
    if (!copied) return;
    const timer = setTimeout(() => setCopied(false), 1500);
    return () => clearTimeout(timer);
  }, [copied]);
  const at = title.indexOf(toast.name);

  return (
    <div
      data-testid="upload-toast"
      className="flex w-[min(320px,calc(100vw-32px))] flex-col gap-1 px-3 py-2.5 bg-panel border border-white/12 rounded-lg text-white/90 font-system shadow-[0_8px_24px_rgba(0,0,0,0.45)] select-text cursor-text"
    >
      <div className="flex items-start gap-2 min-w-0">
        <CircleAlert aria-hidden="true" size={14} className="mt-px shrink-0 text-danger" />
        <span className="min-w-0 flex-1 wrap-anywhere text-[12.5px] leading-4 font-semibold">
          {at < 0 ? (
            title
          ) : (
            <>
              {title.slice(0, at)}
              <span className="font-mono text-[11.5px] font-medium">{toast.name}</span>
              {title.slice(at + toast.name.length)}
            </>
          )}
        </span>
        <button
          type="button"
          aria-label="Dismiss upload error"
          className="-mt-0.5 -mr-1.5 grid size-5 shrink-0 cursor-pointer place-items-center rounded text-white/45 hover:bg-white/10 hover:text-white/80"
          onClick={onDismiss}
        >
          <X aria-hidden="true" size={14} />
        </button>
      </div>
      <p
        className={`ml-[22px] wrap-anywhere text-[12px] leading-[1.45] text-white/60 ${details ? "line-clamp-2" : ""}`}
      >
        {body}
      </p>
      {details && (
        <>
          <div className="ml-[22px] flex items-center justify-between text-[11.5px] font-medium text-white/75">
            <button
              type="button"
              aria-expanded={open}
              aria-controls={detailsId}
              className="-ml-1.5 inline-flex cursor-pointer items-center gap-1 rounded px-1.5 py-0.5 hover:bg-white/10"
              onClick={() => setOpen(!open)}
            >
              <ChevronRight
                aria-hidden="true"
                size={12}
                className={`transition-transform ${open ? "rotate-90" : ""}`}
              />
              Details
            </button>
            <button
              type="button"
              className="-mr-1.5 inline-flex cursor-pointer items-center gap-1 rounded px-1.5 py-0.5 hover:bg-white/10"
              onClick={() =>
                // Without clipboard access, show the text so it can be selected by hand.
                void copyTextToClipboard(`${title}\n\n${details}`).then((ok) =>
                  ok ? setCopied(true) : setOpen(true),
                )
              }
            >
              {copied ? (
                <Check aria-hidden="true" size={12} />
              ) : (
                <Copy aria-hidden="true" size={12} />
              )}
              {copied ? "Copied" : "Copy"}
            </button>
          </div>
          <pre
            id={detailsId}
            hidden={!open}
            className="ml-[22px] max-h-32 overflow-auto whitespace-pre-wrap wrap-anywhere rounded-md border border-white/8 bg-black/40 px-2 py-1.5 font-mono text-[11px] leading-normal text-white/60"
          >
            {details}
          </pre>
        </>
      )}
    </div>
  );
}

export type ShareLinkToast = {
  url: string;
  copied: boolean;
  carriesToken: boolean;
};

export function ShareLinkToastContent({ toast }: { toast: ShareLinkToast }) {
  return (
    <div
      data-testid="share-link-toast"
      className="flex w-[min(360px,calc(100vw-32px))] flex-col gap-1.5 px-3 py-2 bg-panel border border-white/12 rounded-lg text-white/90 text-[12px] font-mono shadow-[0_8px_24px_rgba(0,0,0,0.45)] select-text cursor-default"
    >
      <div className="flex items-center gap-2 min-w-0">
        <span
          className="size-1.5 rounded-full shrink-0"
          style={{ background: toast.copied ? "#4ade80" : "#fbbf24" }}
        />
        <span className="flex-1 overflow-hidden text-ellipsis whitespace-nowrap font-semibold">
          {toast.copied ? "Share link copied" : "Copy this share link"}
        </span>
      </div>
      {!toast.copied && (
        <input
          readOnly
          value={toast.url}
          aria-label="Share link"
          onFocus={(e) => e.currentTarget.select()}
          className="w-full min-w-0 h-7 px-2 rounded-md bg-black/40 border border-white/12 text-white/90 text-[11px] font-mono outline-none focus:border-accent"
        />
      )}
      <span className="text-white/60 leading-snug">
        {toast.carriesToken
          ? "The link includes the access token. Anyone who has it can control this simulator."
          : "Anyone who can reach this address can open it."}
      </span>
    </div>
  );
}

export function pasteFieldHint(coarsePointer: boolean): string {
  return coarsePointer ? "Long-press and paste" : "Press ⌘V or Ctrl+V to paste";
}

function PasteField({ message, onSubmit }: { message: string; onSubmit: (text: string) => void }) {
  const [text, setText] = useState("");
  const coarsePointer = useCoarsePointer();
  const field = useRef<HTMLTextAreaElement>(null);
  // Preact renders autoFocus as the autofocus attribute, which browsers ignore after page load.
  useEffect(() => field.current?.focus(), []);
  return (
    <form
      className="flex flex-col gap-1.5 flex-1 min-w-0"
      onSubmit={(event) => {
        event.preventDefault();
        if (text) onSubmit(text);
      }}
    >
      <span className="break-words whitespace-normal">{message}</span>
      <div className="flex items-end gap-2 min-w-0">
        {/* A textarea keeps pasted line breaks; an input would strip them. */}
        <textarea
          ref={field}
          data-suspend-keyboard-capture
          rows={2}
          value={text}
          onChange={(event) => setText(event.target.value)}
          onKeyDown={(event) => {
            if (event.key === "Enter" && (event.metaKey || event.ctrlKey)) {
              event.preventDefault();
              event.currentTarget.form?.requestSubmit();
            }
          }}
          placeholder={pasteFieldHint(coarsePointer)}
          autoCapitalize="off"
          autoCorrect="off"
          spellCheck={false}
          aria-label="Text to paste into the simulator"
          className="flex-1 min-w-0 max-h-24 resize-none px-2 py-1 rounded bg-black/40 border border-white/15 text-white/90 text-[12px] outline-none focus:border-white/35"
        />
        <button
          type="submit"
          disabled={!text}
          className="shrink-0 px-2 py-0.5 rounded border border-white/20 text-white/90 hover:bg-white/10 disabled:opacity-40"
        >
          Send
        </button>
      </div>
    </form>
  );
}

export function ClipboardToastContent({
  toast,
  onCopy,
  onPaste,
}: {
  toast: ClipboardToast;
  onCopy?: () => void;
  onPaste?: (text: string) => void;
}) {
  const pending = toast.status === "pending";
  const dotColor =
    pending || toast.status === "paste" || toast.status === "info"
      ? "#a5b4fc"
      : toast.status === "success"
        ? "#4ade80"
        : toast.status === "manual"
          ? "#fcd34d"
          : "#f87171";

  return (
    <div
      data-testid="clipboard-toast"
      className={`flex w-[min(320px,calc(100vw-32px))] items-center gap-2 px-3 py-2 bg-panel border border-white/12 rounded-lg text-white/90 text-[12px] font-mono shadow-[0_8px_24px_rgba(0,0,0,0.45)] ${toast.status === "error" ? "select-text cursor-text" : "select-none cursor-default"}`}
    >
      <span
        className={`size-1.5 rounded-full shrink-0 ${pending ? "animate-pulse" : ""}`}
        style={{ background: dotColor }}
      />
      {toast.status === "paste" && onPaste ? (
        <PasteField message={toast.message} onSubmit={onPaste} />
      ) : (
        <span className="min-w-0 flex-1 break-words whitespace-normal">{toast.message}</span>
      )}
      {toast.status === "manual" && (
        <button
          type="button"
          onClick={onCopy}
          className="shrink-0 px-2 py-0.5 rounded border border-white/20 text-white/90 hover:bg-white/10"
        >
          Copy
        </button>
      )}
    </div>
  );
}
