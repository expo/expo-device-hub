/// Initial shared H.264 request. A capability probe identifies the paravirtualized
/// environment; it does not identify the backend used by a live compression session.
public enum WebRTCH264RateControlPolicy {
    public static func prefersLowLatency(fixedPanel: Bool, probeEncoderID: String?) -> Bool {
        guard fixedPanel, let probeEncoderID else { return true }
        return !probeEncoderID.hasPrefix("paravirtualized:")
    }
}
