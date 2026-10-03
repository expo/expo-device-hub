export class Peer {
  static instances: Peer[] = [];
  iceGatheringState = "complete";
  connectionState = "connected";
  localDescription = { type: "offer", sdp: "offer" };
  ontrack?: (event: { streams: object[]; track: object }) => void;

  constructor() {
    Peer.instances.push(this);
  }
  addTransceiver() {
    return {};
  }
  async createOffer() {
    return this.localDescription;
  }
  async setLocalDescription() {}
  async setRemoteDescription() {}
  close() {}
}

export class Video extends EventTarget {
  readonly tagName = "VIDEO";
  videoWidth = 360;
  videoHeight = 720;
  srcObject: object | null = null;
  callback: VideoFrameRequestCallback | null = null;
  presentedFrames = 0;
  requestVideoFrameCallback?: (callback: VideoFrameRequestCallback) => number;

  constructor(useVideoFrameCallback: boolean) {
    super();
    if (useVideoFrameCallback) {
      this.requestVideoFrameCallback = (callback) => {
        this.callback = callback;
        return 1;
      };
    }
  }
  cancelVideoFrameCallback() {
    this.callback = null;
  }
  removeAttribute() {}
  async play() {}
  frame() {
    if (this.requestVideoFrameCallback) {
      this.callback?.(performance.now(), {
        presentedFrames: ++this.presentedFrames,
        width: this.videoWidth,
        height: this.videoHeight,
        mediaTime: 0,
        presentationTime: 0,
        expectedDisplayTime: 0,
        processingDuration: 0,
      });
    } else {
      this.dispatchEvent(new Event("timeupdate"));
    }
  }
}
