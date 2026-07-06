/**
 * Media Source Extensions fallback decoder for the serve-emu (Android) H.264
 * stream. Ported from serve-emu's web UI (`src/ui/lib/mse-player.ts`).
 *
 * WebCodecs (`VideoDecoder`) is a secure-context-only API, so it is missing when
 * Hub is opened over a plain-HTTP LAN origin (`http://192.168.x.x:8081`,
 * `isSecureContext === false`). MSE is *not* secure-context gated and decodes
 * H.264 through a `<video>` element, so this player is the fallback used when
 * `VideoDecoder` is unavailable.
 *
 * It muxes each Annex-B access unit into a fragmented-MP4 segment (see
 * {@link FragmentedMp4Muxer}), appends it to a `SourceBuffer`, keeps a detached
 * `<video>` pinned to the live edge, and blits decoded frames onto the same
 * `<canvas>` the WebCodecs path paints — so `DeviceScreen` and input mapping are
 * unchanged.
 */

import { FragmentedMp4Muxer } from './mp4-muxer';

/** Broadly-supported baseline H.264 type; the floor for the MSE path being usable. */
const BASELINE_MP4 = 'video/mp4; codecs="avc1.42E01E"';

// Latency tuning. Hub runs on local/low-latency networks, so hug the live edge:
// keep only a couple of frames of slack and shed any extra latency fast.
/** Target slack behind the live edge (~1–2 frames). Below this, play at 1×. */
const TARGET_LATENCY_SEC = 0.05;
/** Above this drift, jump straight to the edge instead of catching up gradually. */
const SEEK_TO_EDGE_SEC = 0.5;
/** Acceleration per second of excess drift when catching up smoothly. */
const CATCHUP_GAIN = 8;
/** Cap on the catch-up speed-up (max playbackRate = 1 + this). */
const MAX_CATCHUP_BOOST = 1.5;
/** Land this close behind the live edge after a jump. */
const EDGE_CUSHION_SEC = 0.03;
/** Keep this much media buffered behind the playhead (must exceed the keyframe interval). */
const MAX_BACK_BUFFER_SEC = 30;

export interface MsePlayerCallbacks {
  onFirstFrame?: () => void;
  onResize?: (width: number, height: number) => void;
  onFps?: (fps: number) => void;
  onError?: (message: string) => void;
  requestKeyframe?: () => void;
}

export class MsePlayer {
  /** True when this browser lacks WebCodecs' `VideoDecoder` but can still play H.264 via MSE. */
  static isSupported(): boolean {
    if (typeof window === 'undefined' || typeof MediaSource === 'undefined') return false;
    try {
      return MediaSource.isTypeSupported(BASELINE_MP4);
    } catch {
      return false;
    }
  }

  private readonly muxer = new FragmentedMp4Muxer();
  private readonly video: HTMLVideoElement;
  private readonly mediaSource: MediaSource;
  private readonly ctx: CanvasRenderingContext2D | null;
  private objectUrl: string;
  private sourceBuffer: SourceBuffer | null = null;
  private readonly queue: Uint8Array[] = [];
  private destroyed = false;
  private painted = false;
  private rafHandle = 0;
  private fpsWindowStart = 0;
  private fpsBaseFrames = 0;

  constructor(
    private readonly canvas: HTMLCanvasElement,
    private readonly callbacks: MsePlayerCallbacks = {},
  ) {
    this.ctx = canvas.getContext('2d', { alpha: false, desynchronized: true });
    const video = document.createElement('video');
    video.muted = true;
    video.defaultMuted = true;
    video.autoplay = true;
    video.playsInline = true;
    video.setAttribute('playsinline', '');
    // Browsers suspend playback of a fully-detached <video>, so keep it in the
    // document but visually negligible — we only read its frames onto the canvas.
    video.style.cssText =
      'position:fixed;left:0;bottom:0;width:4px;height:4px;opacity:0.01;pointer-events:none;z-index:-1;';
    (document.body ?? document.documentElement).appendChild(video);
    this.video = video;
    this.mediaSource = new MediaSource();
    this.objectUrl = URL.createObjectURL(this.mediaSource);
    video.src = this.objectUrl;
    this.mediaSource.addEventListener('sourceopen', this.onSourceOpen, { once: true });
    video.addEventListener('error', this.onVideoError);
    this.rafHandle = requestAnimationFrame(this.tick);
  }

  /** Feed one Annex-B access unit (payload after the frame-meta header). */
  feed(au: Uint8Array, isKey: boolean, ptsUs: number | null): void {
    if (this.destroyed) return;
    // MSE must start on a keyframe, and the muxer needs SPS/PPS (which ride the
    // keyframe) before it can emit an init segment — so ask for one until we have it.
    if (!this.muxer.ready && !isKey) {
      this.callbacks.requestKeyframe?.();
      return;
    }
    const { init, segment } = this.muxer.append(au, isKey, ptsUs);
    if (init) {
      this.queue.push(init);
      this.setupSourceBuffer();
    }
    if (segment) this.queue.push(segment);
    this.pump();
  }

  destroy(): void {
    this.destroyed = true;
    if (this.rafHandle) cancelAnimationFrame(this.rafHandle);
    this.rafHandle = 0;
    this.video.removeEventListener('error', this.onVideoError);
    try {
      if (this.sourceBuffer) this.sourceBuffer.removeEventListener('updateend', this.pump);
    } catch {}
    try {
      if (this.mediaSource.readyState === 'open') this.mediaSource.endOfStream();
    } catch {}
    try {
      this.video.pause();
      this.video.removeAttribute('src');
      this.video.load();
      this.video.remove();
    } catch {}
    try {
      URL.revokeObjectURL(this.objectUrl);
    } catch {}
    this.queue.length = 0;
  }

  private onSourceOpen = (): void => {
    try {
      URL.revokeObjectURL(this.objectUrl);
    } catch {}
    this.setupSourceBuffer();
    this.pump();
  };

  private onVideoError = (): void => {
    if (!this.destroyed) this.callbacks.onError?.('Video playback error');
  };

  private setupSourceBuffer(): void {
    if (this.sourceBuffer || this.mediaSource.readyState !== 'open') return;
    const codec = this.muxer.codec;
    if (!codec) return; // no SPS seen yet
    let type = `video/mp4; codecs="${codec}"`;
    if (!MediaSource.isTypeSupported(type)) {
      // The exact profile string is unsupported but the browser can still decode
      // the real profile from the in-band SPS — declare the baseline type.
      if (!MediaSource.isTypeSupported(BASELINE_MP4)) {
        this.callbacks.onError?.('This browser cannot decode this H.264 profile.');
        return;
      }
      type = BASELINE_MP4;
    }
    try {
      const sb = this.mediaSource.addSourceBuffer(type);
      sb.mode = 'segments';
      sb.addEventListener('updateend', this.pump);
      this.sourceBuffer = sb;
    } catch {
      this.callbacks.onError?.('Failed to start MSE video buffer.');
    }
  }

  private pump = (): void => {
    const sb = this.sourceBuffer;
    if (this.destroyed || !sb || sb.updating || this.mediaSource.readyState !== 'open') return;
    if (this.pruneBackBuffer()) return; // a remove() was started; resume on its updateend
    const chunk = this.queue.shift();
    if (!chunk) return;
    try {
      // Our buffers are always backed by a plain ArrayBuffer; the cast satisfies
      // the DOM lib's `BufferSource` (ArrayBufferView<ArrayBuffer>) parameter.
      sb.appendBuffer(chunk as BufferSource);
    } catch (err) {
      if ((err as DOMException)?.name === 'QuotaExceededError') {
        // Buffer full: put the chunk back and free space aggressively.
        this.queue.unshift(chunk);
        this.pruneBackBuffer(true);
      } else {
        this.callbacks.onError?.('Failed to append video data.');
      }
    }
  };

  /** Drop already-played media to bound memory/latency. Returns true if a remove() ran. */
  private pruneBackBuffer(force = false): boolean {
    const sb = this.sourceBuffer;
    if (!sb || sb.updating || sb.buffered.length === 0) return false;
    const start = sb.buffered.start(0);
    const keepFrom = this.video.currentTime - (force ? 3 : MAX_BACK_BUFFER_SEC);
    if (keepFrom > start + 0.1) {
      try {
        sb.remove(start, keepFrom);
        return true;
      } catch {
        return false;
      }
    }
    return false;
  }

  private tick = (): void => {
    if (this.destroyed) return;
    this.rafHandle = requestAnimationFrame(this.tick);
    const video = this.video;

    // Hug the live edge to keep interaction latency minimal. Prefer playbackRate
    // catch-up — it decodes every frame in order, so no H.264 ghosting — and only
    // jump when we're outside the buffered range or too far behind to close the
    // gap smoothly. A jump lands *inside* buffered data whose keyframe is still
    // buffered, so it resyncs cleanly (never seek past unbuffered frames).
    const buffered = video.buffered;
    if (buffered.length > 0) {
      const start = buffered.start(0);
      const end = buffered.end(buffered.length - 1);
      const drift = end - video.currentTime;
      if (video.currentTime > end + 0.05 || video.currentTime < start - 0.05 || drift > SEEK_TO_EDGE_SEC) {
        try {
          video.currentTime = Math.max(start, end - EDGE_CUSHION_SEC);
        } catch {}
        video.playbackRate = 1;
      } else if (drift > TARGET_LATENCY_SEC) {
        video.playbackRate = 1 + Math.min((drift - TARGET_LATENCY_SEC) * CATCHUP_GAIN, MAX_CATCHUP_BOOST);
      } else {
        video.playbackRate = 1;
      }
    }
    if (video.paused && video.readyState >= 2) {
      void video.play().catch(() => {});
    }

    if (video.videoWidth === 0) return;
    if (!this.painted) {
      this.painted = true;
      this.canvas.width = video.videoWidth;
      this.canvas.height = video.videoHeight;
      this.callbacks.onResize?.(video.videoWidth, video.videoHeight);
      this.callbacks.onFirstFrame?.();
      this.fpsWindowStart = performance.now();
      this.fpsBaseFrames = video.getVideoPlaybackQuality?.().totalVideoFrames ?? 0;
    }
    if (this.ctx) this.ctx.drawImage(video, 0, 0);

    this.reportFps();
  };

  private reportFps(): void {
    const now = performance.now();
    if (now - this.fpsWindowStart < 1000) return;
    const total = this.video.getVideoPlaybackQuality?.().totalVideoFrames;
    if (total != null) {
      const fps = Math.round(((total - this.fpsBaseFrames) * 1000) / (now - this.fpsWindowStart));
      this.callbacks.onFps?.(fps);
      this.fpsBaseFrames = total;
    }
    this.fpsWindowStart = now;
  }
}
