import { useCallback, useEffect, useRef, useState } from "react";
import {
  type StreamModeResponse,
  type StreamEncoderSettingsResponse,
} from "../../shared/api-contracts";
import {
  MAX_H264_BITRATE,
  MAX_H264_FPS,
  MAX_STREAM_DIMENSION,
  MIN_H264_BITRATE,
  streamEncoderSettingsEqual,
  type StreamEncoderSettings,
  type StreamEncoderSettingsPatch,
} from "../../stream-settings";
import { apiRequest } from "../lib/api-client";
import {
  type DeviceSessionStore,
  deviceSessionStore,
  useDeviceSessionSnapshot,
} from "../lib/device-session-store";
import { usePoll } from "../lib/use-poll";

type LoadedStreamSettings = StreamEncoderSettingsResponse & {
  revision: number;
  serial: string | null;
};

export type StreamQualityDraft = {
  maxDimension: string;
  h264BitrateMbps: string;
  h264Fps: string;
};

export type StreamQualityDraftResult =
  | { ok: true; patch: StreamEncoderSettingsPatch }
  | {
      ok: false;
      field: keyof StreamQualityDraft;
      message: string;
    };

export type StreamQualityApplyDependencies = {
  store: DeviceSessionStore;
  patchSettings: (
    patch: StreamEncoderSettingsPatch,
  ) => Promise<StreamEncoderSettingsResponse>;
  readStreamMode: () => Promise<StreamModeResponse>;
};

export type StreamQualityDirtyFields = Partial<
  Record<keyof StreamQualityDraft, true>
>;

export type StreamQualityFeedback = {
  revision: number;
  kind: "status" | "error";
  message: string;
  field?: keyof StreamQualityDraft;
  appliedSettings?: StreamEncoderSettings;
};

const MEGABIT = 1_000_000;
const STREAM_SETTINGS_POLL_INTERVAL_MS = 4_000;
const MIN_H264_BITRATE_MBPS = MIN_H264_BITRATE / MEGABIT;
const MAX_H264_BITRATE_MBPS = MAX_H264_BITRATE / MEGABIT;

function integerValue(
  value: string,
  min: number,
  max: number,
): number | null {
  if (value.trim() === "") return null;
  const parsed = Number(value);
  return Number.isSafeInteger(parsed) && parsed >= min && parsed <= max
    ? parsed
    : null;
}

export function streamQualityDraft(
  settings: StreamEncoderSettings,
): StreamQualityDraft {
  return {
    maxDimension: String(settings.maxDimension),
    h264BitrateMbps: String(settings.h264Bitrate / MEGABIT),
    h264Fps: String(settings.h264Fps),
  };
}

export function mergeStreamQualityDraft(
  current: StreamQualityDraft,
  incoming: StreamQualityDraft,
  dirtyFields: StreamQualityDirtyFields,
): StreamQualityDraft {
  return {
    maxDimension: dirtyFields.maxDimension
      ? current.maxDimension
      : incoming.maxDimension,
    h264BitrateMbps: dirtyFields.h264BitrateMbps
      ? current.h264BitrateMbps
      : incoming.h264BitrateMbps,
    h264Fps: dirtyFields.h264Fps ? current.h264Fps : incoming.h264Fps,
  };
}

export function streamQualityDirtyFields(
  draft: StreamQualityDraft,
  baseline: StreamQualityDraft,
): StreamQualityDirtyFields {
  const dirtyFields: StreamQualityDirtyFields = {};
  if (draft.maxDimension !== baseline.maxDimension) {
    dirtyFields.maxDimension = true;
  }
  if (draft.h264BitrateMbps !== baseline.h264BitrateMbps) {
    dirtyFields.h264BitrateMbps = true;
  }
  if (draft.h264Fps !== baseline.h264Fps) {
    dirtyFields.h264Fps = true;
  }
  return dirtyFields;
}

export function streamQualityPatchFromDraft(
  draft: StreamQualityDraft,
  current: StreamEncoderSettings,
): StreamQualityDraftResult {
  const maxDimension = integerValue(
    draft.maxDimension,
    0,
    MAX_STREAM_DIMENSION,
  );
  if (maxDimension === null) {
    return {
      ok: false,
      field: "maxDimension",
      message: `Max dimension must be a whole number from 0 to ${MAX_STREAM_DIMENSION}.`,
    };
  }

  const bitrateMbps = draft.h264BitrateMbps.trim() === ""
    ? Number.NaN
    : Number(draft.h264BitrateMbps);
  if (
    !Number.isFinite(bitrateMbps) ||
    bitrateMbps < MIN_H264_BITRATE_MBPS ||
    bitrateMbps > MAX_H264_BITRATE_MBPS
  ) {
    return {
      ok: false,
      field: "h264BitrateMbps",
      message: `Bitrate must be from ${MIN_H264_BITRATE_MBPS} to ${MAX_H264_BITRATE_MBPS} Mbps.`,
    };
  }
  const scaledBitrate = bitrateMbps * MEGABIT;
  const h264Bitrate = Math.round(scaledBitrate);
  if (
    !Number.isSafeInteger(h264Bitrate) ||
    Math.abs(scaledBitrate - h264Bitrate) > 0.000_001
  ) {
    return {
      ok: false,
      field: "h264BitrateMbps",
      message: "Bitrate supports at most six decimal places in Mbps.",
    };
  }

  const h264Fps = integerValue(draft.h264Fps, 1, MAX_H264_FPS);
  if (h264Fps === null) {
    return {
      ok: false,
      field: "h264Fps",
      message: `Frame rate must be a whole number from 1 to ${MAX_H264_FPS}.`,
    };
  }

  const patch: StreamEncoderSettingsPatch = {};
  if (maxDimension !== current.maxDimension) {
    patch.maxDimension = maxDimension;
  }
  if (h264Bitrate !== current.h264Bitrate) {
    patch.h264Bitrate = h264Bitrate;
  }
  if (h264Fps !== current.h264Fps) {
    patch.h264Fps = h264Fps;
  }
  return { ok: true, patch };
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

const DEFAULT_APPLY_DEPENDENCIES: StreamQualityApplyDependencies = {
  store: deviceSessionStore,
  patchSettings: (patch) =>
    apiRequest("/api/stream-settings", {
      method: "PATCH",
      body: patch,
    }),
  readStreamMode: () =>
    apiRequest("/api/stream-mode", {
      method: "GET",
      cache: "no-store",
    }),
};

export async function applyStreamQualitySettings(
  patch: StreamEncoderSettingsPatch,
  serial: string | null,
  dependencies: StreamQualityApplyDependencies = DEFAULT_APPLY_DEPENDENCIES,
): Promise<{
  settings: StreamEncoderSettingsResponse;
  revision: number;
}> {
  dependencies.store.beginTransition(serial);
  let settings: StreamEncoderSettingsResponse | null = null;
  let streamMode: StreamModeResponse | null = null;
  let patchFailed = false;
  let patchError: unknown = null;
  try {
    try {
      settings = await dependencies.patchSettings(patch);
    } catch (error) {
      patchFailed = true;
      patchError = error;
    }
    try {
      streamMode = await dependencies.readStreamMode();
    } catch {
      // A later stream-mode poll can still synchronize the session identity.
    }
  } finally {
    dependencies.store.endTransition();
  }
  if (streamMode) dependencies.store.applyHealth(streamMode);
  if (patchFailed) throw patchError;
  if (!settings) throw new Error("Stream settings update returned no result");
  return {
    settings,
    revision: dependencies.store.getSnapshot().revision,
  };
}

export function streamQualityStatus({
  busy,
  transitioning,
  selectionReady,
  feedback,
}: {
  busy: boolean;
  transitioning: boolean;
  selectionReady: boolean;
  feedback: StreamQualityFeedback | null;
}): string {
  if (busy) return "Restarting…";
  if (transitioning) return "Waiting…";
  if (!selectionReady) {
    return feedback?.kind === "error" ? "Unavailable" : "Loading…";
  }
  return feedback?.kind === "error"
    ? "Needs attention"
    : feedback?.message ?? "Ready";
}

export function StreamSettingsPanel() {
  const deviceSession = useDeviceSessionSnapshot();
  const actionId = useRef(0);
  const [loaded, setLoaded] = useState<LoadedStreamSettings | null>(null);
  const [draft, setDraft] = useState<StreamQualityDraft | null>(null);
  const [feedback, setFeedback] =
    useState<StreamQualityFeedback | null>(null);
  const [busy, setBusy] = useState(false);

  useEffect(
    () => () => {
      actionId.current += 1;
    },
    [],
  );

  usePoll({
    poll: ({ signal }) =>
      apiRequest("/api/stream-settings", {
        method: "GET",
        cache: "no-store",
        signal,
      }),
    onResult: (response, context) => {
      const currentSession = deviceSessionStore.getSnapshot();
      const freshDraft = streamQualityDraft(response);
      const dirtyFields = draft && loaded
        ? streamQualityDirtyFields(draft, streamQualityDraft(loaded))
        : {};
      const preserveDraft =
        loaded?.serial === currentSession.serial &&
        draft !== null &&
        Object.keys(dirtyFields).length > 0;
      const nextDraft = preserveDraft
        ? mergeStreamQualityDraft(draft, freshDraft, dirtyFields)
        : freshDraft;
      const nextDirtyFields = streamQualityDirtyFields(nextDraft, freshDraft);
      const hasUnsavedChanges = Object.keys(nextDirtyFields).length > 0;
      setLoaded({
        ...response,
        revision: context.key,
        serial: currentSession.serial,
      });
      setDraft(nextDraft);
      setFeedback((current) => {
        if (hasUnsavedChanges) {
          return current?.kind === "error" &&
            current.field &&
            nextDirtyFields[current.field]
            ? { ...current, revision: context.key }
            : {
                revision: context.key,
                kind: "status",
                message: "Unsaved changes",
              };
        }
        if (
          current?.kind === "status" &&
          current.message === "Applied" &&
          current.appliedSettings &&
          streamEncoderSettingsEqual(current.appliedSettings, response)
        ) {
          return { ...current, revision: context.key };
        }
        return {
          revision: context.key,
          kind: "status",
          message: "Ready",
        };
      });
    },
    onError: (error, context) => {
      const currentSerial = deviceSessionStore.getSnapshot().serial;
      if (loaded?.serial !== currentSerial) {
        setLoaded(null);
        setDraft(null);
      }
      setFeedback({
        revision: context.key,
        kind: "error",
        message: errorMessage(error),
      });
    },
    intervalMs: STREAM_SETTINGS_POLL_INTERVAL_MS,
    pollKey: deviceSession.revision,
    enabled: !deviceSession.transitioning && !busy,
  });

  const selectionReady =
    !deviceSession.transitioning &&
    loaded?.revision === deviceSession.revision &&
    draft !== null;
  const matchingFeedback = feedback?.revision === deviceSession.revision
    ? feedback
    : null;
  const status = streamQualityStatus({
    busy,
    transitioning: deviceSession.transitioning,
    selectionReady,
    feedback: matchingFeedback,
  });
  const visibleError = matchingFeedback?.kind === "error"
    ? matchingFeedback.message
    : null;
  const initialDraft = loaded ? streamQualityDraft(loaded) : null;
  const changed = draft !== null &&
    initialDraft !== null &&
    Object.keys(streamQualityDirtyFields(draft, initialDraft)).length > 0;

  const updateDraft = useCallback(
    (field: keyof StreamQualityDraft, value: string) => {
      if (!draft || !loaded) return;
      const nextDraft = { ...draft, [field]: value };
      const hasUnsavedChanges = Object.keys(
        streamQualityDirtyFields(nextDraft, streamQualityDraft(loaded)),
      ).length > 0;
      setDraft(nextDraft);
      setFeedback({
        revision: deviceSessionStore.getSnapshot().revision,
        kind: "status",
        message: hasUnsavedChanges ? "Unsaved changes" : "Ready",
      });
    },
    [draft, loaded],
  );

  const apply = useCallback(
    async (event: React.FormEvent<HTMLFormElement>) => {
      event.preventDefault();
      if (busy || !selectionReady || !loaded || !draft) return;

      const parsed = streamQualityPatchFromDraft(draft, loaded);
      if (!parsed.ok) {
        setFeedback({
          revision: deviceSession.revision,
          kind: "error",
          message: parsed.message,
          field: parsed.field,
        });
        return;
      }

      if (Object.keys(parsed.patch).length === 0) {
        setDraft(streamQualityDraft(loaded));
        setFeedback({
          revision: deviceSession.revision,
          kind: "status",
          message: "Ready",
        });
        return;
      }

      const previous = loaded;
      const id = ++actionId.current;
      setBusy(true);
      setFeedback({
        revision: deviceSession.revision,
        kind: "status",
        message: "Restarting…",
      });
      let response: StreamEncoderSettingsResponse | null = null;
      let appliedRevision: number | null = null;
      let failure: unknown = null;
      try {
        const applied = await applyStreamQualitySettings(
          parsed.patch,
          deviceSession.serial,
        );
        response = applied.settings;
        appliedRevision = applied.revision;
      } catch (error) {
        failure = error;
      }

      const revision =
        appliedRevision ?? deviceSessionStore.getSnapshot().revision;
      if (id !== actionId.current) return;

      if (response) {
        setLoaded({
          ...response,
          revision,
          serial: deviceSessionStore.getSnapshot().serial,
        });
        setDraft(streamQualityDraft(response));
        setFeedback({
          revision,
          kind: "status",
          message: "Applied",
          appliedSettings: response,
        });
      } else {
        setLoaded({ ...previous, revision });
        setFeedback({
          revision,
          kind: "error",
          message: errorMessage(failure),
        });
      }
      setBusy(false);
    },
    [busy, deviceSession.revision, deviceSession.serial, draft, loaded, selectionReady],
  );

  const disabled = busy || deviceSession.transitioning || !selectionReady;
  const errorField = matchingFeedback?.kind === "error"
    ? matchingFeedback.field
    : undefined;
  const fieldErrorId = visibleError && errorField
    ? "stream-quality-error"
    : undefined;

  return (
    <section
      className="stream-quality-panel"
      aria-labelledby="stream-quality-heading"
    >
      <div className="stream-quality-heading">
        <h3 id="stream-quality-heading">Quality</h3>
        <div
          className="location-status"
          role={visibleError ? undefined : "status"}
          aria-live={visibleError ? undefined : "polite"}
          aria-atomic={visibleError ? undefined : "true"}
          aria-hidden={visibleError ? "true" : undefined}
        >
          {status}
        </div>
      </div>
      <form
        className="stream-quality-form"
        aria-busy={disabled}
        aria-describedby="stream-quality-help"
        noValidate
        onSubmit={(event) => void apply(event)}
      >
        <fieldset disabled={disabled}>
          <legend className="visually-hidden">Stream quality</legend>
          <div className="stream-quality-fields">
            <label htmlFor="stream-max-dimension">
              <span>Max dimension (px)</span>
              <input
                id="stream-max-dimension"
                name="maxDimension"
                type="number"
                min="0"
                max={MAX_STREAM_DIMENSION}
                step="1"
                list="stream-dimension-presets"
                autoComplete="off"
                spellCheck={false}
                data-lpignore="true"
                data-1p-ignore="true"
                value={draft?.maxDimension ?? ""}
                aria-invalid={errorField === "maxDimension"}
                aria-describedby={
                  errorField === "maxDimension" ? fieldErrorId : undefined
                }
                onChange={(event) =>
                  updateDraft("maxDimension", event.target.value)
                }
              />
            </label>
            <label htmlFor="stream-bitrate">
              <span>Bitrate (Mbps)</span>
              <input
                id="stream-bitrate"
                name="h264BitrateMbps"
                type="number"
                min={MIN_H264_BITRATE_MBPS}
                max={MAX_H264_BITRATE_MBPS}
                step="0.1"
                list="stream-bitrate-presets"
                autoComplete="off"
                spellCheck={false}
                data-lpignore="true"
                data-1p-ignore="true"
                value={draft?.h264BitrateMbps ?? ""}
                aria-invalid={errorField === "h264BitrateMbps"}
                aria-describedby={
                  errorField === "h264BitrateMbps"
                    ? fieldErrorId
                    : undefined
                }
                onChange={(event) =>
                  updateDraft("h264BitrateMbps", event.target.value)
                }
              />
            </label>
            <label htmlFor="stream-frame-rate">
              <span>Frame rate (fps)</span>
              <input
                id="stream-frame-rate"
                name="h264Fps"
                type="number"
                min="1"
                max={MAX_H264_FPS}
                step="1"
                list="stream-fps-presets"
                autoComplete="off"
                spellCheck={false}
                data-lpignore="true"
                data-1p-ignore="true"
                value={draft?.h264Fps ?? ""}
                aria-invalid={errorField === "h264Fps"}
                aria-describedby={
                  errorField === "h264Fps" ? fieldErrorId : undefined
                }
                onChange={(event) =>
                  updateDraft("h264Fps", event.target.value)
                }
              />
            </label>
          </div>
          <datalist id="stream-dimension-presets">
            <option value="0">Native</option>
            <option value="720">720 px</option>
            <option value="1080">1080 px</option>
          </datalist>
          <datalist id="stream-bitrate-presets">
            <option value="2">2 Mbps</option>
            <option value="4">4 Mbps</option>
            <option value="8">8 Mbps</option>
            <option value="12">12 Mbps</option>
          </datalist>
          <datalist id="stream-fps-presets">
            <option value="15">15 fps</option>
            <option value="30">30 fps</option>
            <option value="60">60 fps</option>
          </datalist>
          <button type="submit" disabled={!changed || disabled}>
            {busy ? "Applying…" : "Apply quality"}
          </button>
        </fieldset>
      </form>
      <p
        className="stream-quality-error"
        id="stream-quality-error"
        role={visibleError ? "alert" : undefined}
      >
        {visibleError ?? ""}
      </p>
      <p className="stream-mode-help" id="stream-quality-help">
        Use 0 for native size. Applying changes restarts the stream. The viewer
        reconnects automatically when needed.
      </p>
    </section>
  );
}
