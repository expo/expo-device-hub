export interface VideoDimensionSource {
  readonly videoWidth: number;
  readonly videoHeight: number;
  addEventListener(type: "loadedmetadata" | "resize", listener: EventListener): void;
  removeEventListener(type: "loadedmetadata" | "resize", listener: EventListener): void;
}

export interface VideoDimensionObserver {
  check(): void;
  disconnect(): void;
}

export function observeVideoDimensions(
  video: VideoDimensionSource,
  onDimensions: (dimensions: { width: number; height: number }) => void,
): VideoDimensionObserver {
  let lastWidth = 0;
  let lastHeight = 0;

  const check = () => {
    const { videoWidth: width, videoHeight: height } = video;
    if (width <= 0 || height <= 0 || (width === lastWidth && height === lastHeight)) return;
    lastWidth = width;
    lastHeight = height;
    onDimensions({ width, height });
  };

  video.addEventListener("loadedmetadata", check);
  video.addEventListener("resize", check);
  check();

  return {
    check,
    disconnect() {
      video.removeEventListener("loadedmetadata", check);
      video.removeEventListener("resize", check);
    },
  };
}
