import { type AndroidGpuInfo } from '@expo/hub-android-utils';
import { useEffect, useState } from 'react';

import { basePath } from './basePath';

/** One bounded read per selected emulator/connection; never show another device's result. */
export function useDeviceGpu(serial: string | null): AndroidGpuInfo | null {
  const [result, setResult] = useState<{ serial: string; gpu: AndroidGpuInfo | null } | null>(null);

  useEffect(() => {
    setResult(null);
    if (!serial) return;
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 5000);
    void (async () => {
      try {
        const response = await fetch(
          `${basePath()}/api/devices/gpu?serial=${encodeURIComponent(serial)}`,
          { signal: controller.signal, cache: 'no-store' },
        );
        if (!response.ok) return;
        const { gpu } = await response.json();
        if (
          !controller.signal.aborted &&
          gpu &&
          typeof gpu.name === 'string' &&
          typeof gpu.renderer === 'string' &&
          (gpu.description === null || typeof gpu.description === 'string')
        ) {
          setResult({ serial, gpu });
        }
      } catch {
        // An unavailable renderer is displayed as Unknown.
      } finally {
        clearTimeout(timeout);
      }
    })();
    return () => {
      controller.abort();
      clearTimeout(timeout);
    };
  }, [serial]);

  return result?.serial === serial ? result.gpu : null;
}
