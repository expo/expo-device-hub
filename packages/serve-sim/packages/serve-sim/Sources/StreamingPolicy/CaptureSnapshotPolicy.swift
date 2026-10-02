/// The size the capture copies the framebuffer at: the largest size any active
/// consumer needs. Zero means native size.
///
/// A recording needs native frames. MJPEG and AVCC consumers need the configured
/// size. WebRTC viewers alone need only the shared canvas, so the copy is made at
/// that size and the viewer resize step passes it through.
public enum CaptureSnapshotPolicy {
    public static func maxDimension(
        recording: Bool, otherConsumers: Bool,
        configuredMaxDimension: Int, viewerCanvasLongEdge: Int
    ) -> Int {
        if recording { return 0 }
        let configured = max(0, configuredMaxDimension)
        if otherConsumers || viewerCanvasLongEdge <= 0 { return configured }
        return configured > 0 ? min(configured, viewerCanvasLongEdge) : viewerCanvasLongEdge
    }
}
