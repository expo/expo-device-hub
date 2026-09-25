import { Toaster, toast } from "sonner";
import type { UploadToast } from "../hooks/use-upload-toasts";

export function ServeSimToaster() {
  return (
    <Toaster
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
  toast.custom(() => (
    <div role="alert" className="max-w-[320px] rounded-md border border-white/12 bg-panel px-3 py-2 font-mono text-[12px] text-white shadow-lg">
      Simulator input failed: {reason}
    </div>
  ), { id: "simulator-input-error" });
}

export function UploadToastContent({ toast }: { toast: UploadToast }) {
  const isError = toast.status === "error";
  const isUploading = toast.status === "uploading";
  const transferring = isUploading && toast.progress !== null;
  const pct = toast.progress != null ? Math.round(toast.progress * 100) : 0;

  return (
    <div
      data-testid="upload-toast"
      className={`flex w-[min(320px,calc(100vw-32px))] flex-col gap-1.5 px-3 py-2 bg-panel border border-white/12 rounded-lg text-white/90 text-[12px] font-mono shadow-[0_8px_24px_rgba(0,0,0,0.45)] ${isError ? "select-text cursor-text" : "select-none cursor-default"}`}
    >
      <div className="flex items-center gap-2 min-w-0">
        <span
          className="size-1.5 rounded-full shrink-0 [transition:background_0.3s]"
          style={{
            background: isUploading
              ? "#a5b4fc"
              : toast.status === "success"
              ? "#4ade80"
              : "#f87171",
          }}
        />
        <span className="flex-1 overflow-hidden text-ellipsis whitespace-nowrap">
          {isUploading && transferring && `Uploading ${toast.name}… ${pct}%`}
          {isUploading && !transferring &&
            (toast.kind === "ipa" ? `Installing ${toast.name}…` : `Adding ${toast.name}…`)}
          {toast.status === "success" &&
            (toast.kind === "ipa" ? `Installed ${toast.name}` : `Added ${toast.name} to Photos`)}
          {isError && `${toast.name}: ${toast.message ?? "Upload failed"}`}
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
