import { useCallback, useEffect, useRef, useState } from 'react';

import { DEFAULT_DEVICE_STREAM_SETTINGS, sameDeviceStreamSettings } from './stream-settings';
import { type DeviceStreamEncoderSettings } from './types';

type StreamSettingsParser = (
  value: unknown,
  fallback: DeviceStreamEncoderSettings,
) => DeviceStreamEncoderSettings | null;

type StreamSettingsPatchBuilder = (
  patch: Partial<DeviceStreamEncoderSettings>,
) => Partial<DeviceStreamEncoderSettings> | null;

interface UseStreamSettingsResourceOptions {
  url: string | null;
  initialSettings: DeviceStreamEncoderSettings | null;
  parse: StreamSettingsParser;
  toPatch: StreamSettingsPatchBuilder;
}

/** Shared GET/PATCH state machine for serve-sim and serve-emu encoder settings. */
export function useStreamSettingsResource({
  url,
  initialSettings,
  parse,
  toPatch,
}: UseStreamSettingsResourceOptions) {
  const [streamSettings, setStreamSettings] = useState<DeviceStreamEncoderSettings | null>(
    initialSettings,
  );
  const [streamSettingsPending, setStreamSettingsPending] = useState(false);
  const requestRef = useRef(0);
  const settingsRef = useRef<DeviceStreamEncoderSettings | null>(initialSettings);
  const pendingRef = useRef(false);
  const readControllerRef = useRef<AbortController | null>(null);
  const writeControllerRef = useRef<AbortController | null>(null);
  const abortRequests = useCallback(() => {
    ++requestRef.current;
    readControllerRef.current?.abort();
    readControllerRef.current = null;
    writeControllerRef.current?.abort();
    writeControllerRef.current = null;
  }, []);

  const requestStreamSettings = useCallback(
    async (clearPendingWhenDone: boolean) => {
      if (!url || readControllerRef.current || writeControllerRef.current) return;
      const request = ++requestRef.current;
      const controller = new AbortController();
      readControllerRef.current = controller;
      try {
        const response = await fetch(url, { cache: 'no-store', signal: controller.signal });
        if (!response.ok) throw new Error(`Stream settings request failed (${response.status})`);
        const next = parse(
          await response.json(),
          settingsRef.current ?? DEFAULT_DEVICE_STREAM_SETTINGS,
        );
        if (!next) throw new Error('Stream settings request returned an invalid response');
        if (!controller.signal.aborted && requestRef.current === request) {
          settingsRef.current = next;
          setStreamSettings((current) =>
            sameDeviceStreamSettings(current, next) ? current : next,
          );
        }
      } catch {
        // Keep the last authoritative value. Callers can retry transient reads.
      } finally {
        if (readControllerRef.current === controller) readControllerRef.current = null;
        if (clearPendingWhenDone && !controller.signal.aborted && requestRef.current === request) {
          pendingRef.current = false;
          setStreamSettingsPending(false);
        }
      }
    },
    [parse, url],
  );

  useEffect(() => {
    abortRequests();
    settingsRef.current = initialSettings;
    setStreamSettings(initialSettings);
    if (!url) {
      pendingRef.current = false;
      setStreamSettingsPending(false);
      return;
    }

    pendingRef.current = true;
    setStreamSettingsPending(true);
    void requestStreamSettings(true);
    return abortRequests;
  }, [abortRequests, initialSettings, requestStreamSettings, url]);

  const updateStreamSettings = useCallback(
    (patch: Partial<DeviceStreamEncoderSettings>) => {
      const requestPatch = toPatch(patch);
      if (!url || !requestPatch || pendingRef.current || writeControllerRef.current) return;
      const previous = settingsRef.current ?? DEFAULT_DEVICE_STREAM_SETTINGS;
      const optimistic = parse({ ...previous, ...requestPatch }, previous);
      if (!optimistic) return;
      readControllerRef.current?.abort();
      readControllerRef.current = null;
      const request = ++requestRef.current;
      const controller = new AbortController();
      writeControllerRef.current = controller;
      pendingRef.current = true;
      settingsRef.current = optimistic;
      setStreamSettings(optimistic);
      setStreamSettingsPending(true);
      void fetch(url, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(requestPatch),
        signal: controller.signal,
      })
        .then(async (response) => {
          if (!response.ok) throw new Error(`Stream settings update failed (${response.status})`);
          const next = parse(await response.json(), optimistic);
          if (!next) throw new Error('Stream settings update returned an invalid response');
          if (!controller.signal.aborted && requestRef.current === request) {
            settingsRef.current = next;
            setStreamSettings(next);
          }
        })
        .catch(() => {
          if (!controller.signal.aborted && requestRef.current === request) {
            settingsRef.current = previous;
            setStreamSettings(previous);
          }
        })
        .finally(() => {
          if (writeControllerRef.current === controller) writeControllerRef.current = null;
          if (!controller.signal.aborted && requestRef.current === request) {
            pendingRef.current = false;
            setStreamSettingsPending(false);
          }
        });
    },
    [parse, toPatch, url],
  );

  const refreshStreamSettings = useCallback(() => {
    void requestStreamSettings(false);
  }, [requestStreamSettings]);

  return {
    streamSettings,
    streamSettingsPending,
    updateStreamSettings,
    refreshStreamSettings,
  };
}
