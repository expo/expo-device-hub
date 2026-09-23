import Foundation

public enum StreamEncodePolicy {
    /// TEMPORARY GUARD, not a fix.
    ///
    /// H.264 sessions have been observed to stall at larger encode sizes — locally a full
    /// 1206x2622 surface dies within seconds while 1920 holds — and the cause is not yet
    /// understood. Several explanations were tested and ruled out (H.264 level limits, and
    /// encoder bitrate starvation), so until it is root-caused we simply do not hand H.264
    /// a full-size Retina surface by default.
    ///
    /// An explicit `--max-dimension` always wins: this only fills in the default. Other
    /// codecs are untouched, since VP8 shows no such failure.
    ///
    /// Remove this once the stall has a real diagnosis.
    public static let h264DefaultMaxLongEdge = 1280

    public static func h264EncodeMaxLongEdge(configuredMaxDimension: Int, codecName: String) -> Int {
        if configuredMaxDimension > 0 { return configuredMaxDimension }
        return codecName.caseInsensitiveCompare("H264") == .orderedSame ? h264DefaultMaxLongEdge : 0
    }
}
