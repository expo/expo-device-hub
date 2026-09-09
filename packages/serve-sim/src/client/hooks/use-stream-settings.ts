import { useCallback, useEffect, useRef, useState } from "react";
import {
  isWebRtcTransportLocked,
  mergeStreamControlSettings,
  mergeStreamEncoderSettings,
  mergeStreamPlaybackSettings,
  normalizeStreamEncoderSettings,
  streamControlSettingsFrom,
  streamEncoderSettingsFrom,
  type StreamControlSettings,
  type StreamEncoderSettings,
  type StreamPlaybackSettings,
  type StreamSettings,
} from "../../stream-settings";

const HTTP_CODEC_STORAGE_KEY = "serve-sim:codec";
const STREAM_SETTINGS_REVALIDATE_INTERVAL_MS = 3000;

function initialControlSettings(initialSettings: StreamSettings | undefined): StreamControlSettings {
  const settings = streamControlSettingsFrom(initialSettings);
  if (settings.transport !== "http" || settings.httpCodec !== "auto") return settings;
  try {
    const stored = window.localStorage.getItem(HTTP_CODEC_STORAGE_KEY);
    if (stored === "auto" || stored === "mjpeg" || stored === "h264") {
      return mergeStreamControlSettings(settings, { httpCodec: stored });
    }
  } catch {
    // Storage can be unavailable in an embedded or privacy-restricted viewer.
  }
  return settings;
}

/** Keep playback choices per viewer while synchronizing shared native encoder controls. */
export function useStreamSettings({
  device,
  endpoint,
  initialSettings,
}: {
  device: string;
  endpoint?: string;
  initialSettings?: StreamSettings;
}) {
  const transportLocked = isWebRtcTransportLocked(initialSettings);
  const [settings, setSettings] = useState<StreamControlSettings>(() =>
    initialControlSettings(initialSettings)
  );
  const [pending, setPending] = useState(false);
  const settingsRef = useRef(settings);
  const pendingRef = useRef(false);
  const requestVersionRef = useRef(0);
  const loadControllerRef = useRef<AbortController | null>(null);
  const updateControllerRef = useRef<AbortController | null>(null);

  useEffect(() => {
    ++requestVersionRef.current;
    const initial = initialControlSettings(initialSettings);
    loadControllerRef.current?.abort();
    updateControllerRef.current?.abort();
    loadControllerRef.current = null;
    updateControllerRef.current = null;
    settingsRef.current = initial;
    pendingRef.current = false;
    setSettings(initial);
    setPending(false);
    if (!endpoint) return;

    let disposed = false;
    let loadFailureLogged = false;
    const refreshEncoderSettings = async () => {
      if (disposed || pendingRef.current || loadControllerRef.current) return;
      const version = ++requestVersionRef.current;
      const controller = new AbortController();
      loadControllerRef.current = controller;
      try {
        const response = await fetch(endpoint, { cache: "no-store", signal: controller.signal });
        if (!response.ok) throw new Error(`Stream settings request failed (${response.status})`);
        const loaded = normalizeStreamEncoderSettings(
          await response.json() as Partial<StreamEncoderSettings>,
          streamEncoderSettingsFrom(settingsRef.current),
        );
        if (!controller.signal.aborted && requestVersionRef.current === version) {
          const current = settingsRef.current;
          const next = mergeStreamEncoderSettings(current, loaded);
          if (next !== current) {
            settingsRef.current = next;
            setSettings(next);
          }
        }
        loadFailureLogged = false;
      } catch (error) {
        if (!controller.signal.aborted && !loadFailureLogged) {
          loadFailureLogged = true;
          console.warn("Failed to load stream settings", error);
        }
      } finally {
        if (loadControllerRef.current === controller) loadControllerRef.current = null;
      }
    };

    void refreshEncoderSettings();
    const refreshWhenVisible = () => {
      if (typeof document === "undefined" || document.visibilityState !== "hidden") {
        void refreshEncoderSettings();
      }
    };
    const timer = setInterval(refreshWhenVisible, STREAM_SETTINGS_REVALIDATE_INTERVAL_MS);
    if (typeof window !== "undefined") window.addEventListener("focus", refreshWhenVisible);
    if (typeof document !== "undefined") {
      document.addEventListener("visibilitychange", refreshWhenVisible);
    }

    return () => {
      disposed = true;
      clearInterval(timer);
      if (typeof window !== "undefined") window.removeEventListener("focus", refreshWhenVisible);
      if (typeof document !== "undefined") {
        document.removeEventListener("visibilitychange", refreshWhenVisible);
      }
      loadControllerRef.current?.abort();
      updateControllerRef.current?.abort();
      loadControllerRef.current = null;
      updateControllerRef.current = null;
    };
  }, [device, endpoint, initialSettings]);

  const updatePlayback = useCallback((patch: Partial<StreamPlaybackSettings>) => {
    if (!transportLocked && patch.httpCodec !== undefined) {
      try {
        window.localStorage.setItem(HTTP_CODEC_STORAGE_KEY, patch.httpCodec);
      } catch {
        // Keep the in-memory preference when storage is unavailable.
      }
    }
    const next = mergeStreamPlaybackSettings(settingsRef.current, patch, transportLocked);
    if (next === settingsRef.current) return;
    settingsRef.current = next;
    setSettings(next);
  }, [transportLocked]);

  const updateEncoder = useCallback((patch: Partial<StreamEncoderSettings>) => {
    if (!endpoint || pendingRef.current || Object.keys(patch).length === 0) return;
    const previous = settingsRef.current;
    const optimistic = mergeStreamEncoderSettings(previous, patch);
    settingsRef.current = optimistic;
    setSettings(optimistic);
    loadControllerRef.current?.abort();
    loadControllerRef.current = null;
    const version = ++requestVersionRef.current;
    const controller = new AbortController();
    updateControllerRef.current = controller;
    pendingRef.current = true;
    setPending(true);

    void fetch(endpoint, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(patch),
      signal: controller.signal,
    }).then(async (response) => {
      if (!response.ok) throw new Error(`Stream settings update failed (${response.status})`);
      const updated = normalizeStreamEncoderSettings(
        await response.json() as Partial<StreamEncoderSettings>,
        streamEncoderSettingsFrom(optimistic),
      );
      if (!controller.signal.aborted && requestVersionRef.current === version) {
        const next = mergeStreamEncoderSettings(settingsRef.current, updated);
        settingsRef.current = next;
        setSettings(next);
      }
    }).catch((error) => {
      if (controller.signal.aborted) return;
      console.warn("Failed to update stream settings", error);
      if (requestVersionRef.current === version) {
        const restored = mergeStreamEncoderSettings(
          settingsRef.current,
          streamEncoderSettingsFrom(previous),
        );
        settingsRef.current = restored;
        setSettings(restored);
      }
    }).finally(() => {
      if (updateControllerRef.current === controller) updateControllerRef.current = null;
      if (!controller.signal.aborted && requestVersionRef.current === version) {
        pendingRef.current = false;
        setPending(false);
      }
    });
  }, [endpoint]);

  return {
    settings,
    updatePlayback,
    updateEncoder,
    pending,
    transportLocked,
    encoderSettingsAvailable: !!endpoint,
  };
}
