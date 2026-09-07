/** Holds a video snapshot across peer teardown and MediaStream replacement. */
export class RetainedVideoFrame {
  private video: HTMLVideoElement | null = null;
  private canvas: HTMLCanvasElement | null = null;
  private retained = false;

  attach(video: HTMLVideoElement | null, canvas: HTMLCanvasElement | null): void {
    if (this.video === video && this.canvas === canvas) return;
    this.reset();
    this.video = video;
    this.canvas = canvas;
    this.release();
  }

  retain(): void {
    const { video, canvas } = this;
    // Never overwrite the saved picture with a closed track or an unready stream.
    if (this.retained || !video || !canvas || video.readyState < 2) return;
    if (video.videoWidth <= 0 || video.videoHeight <= 0) return;
    try {
      const context = canvas.getContext('2d');
      if (!context) return;
      canvas.width = video.videoWidth;
      canvas.height = video.videoHeight;
      context.drawImage(video, 0, 0);
      canvas.style.visibility = 'visible';
      this.retained = true;
    } catch {
      // A video without a drawable frame must not prevent transport recovery.
    }
  }

  release(): void {
    if (this.canvas) this.canvas.style.visibility = 'hidden';
    this.retained = false;
  }

  reset(): void {
    this.release();
    if (this.canvas) {
      this.canvas.width = 0;
      this.canvas.height = 0;
    }
  }
}
