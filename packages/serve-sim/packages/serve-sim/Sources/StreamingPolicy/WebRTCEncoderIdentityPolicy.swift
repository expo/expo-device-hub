import Foundation

/// What the diagnostics row may claim about the encoder behind a live stream.
public enum WebRTCEncoderIdentityPolicy {
    public struct Identity: Equatable {
        public let id: String?
        public let hardware: Bool?
        public let codec: String?
        public let probe: Bool

        public init(id: String?, hardware: Bool?, codec: String?, probe: Bool) {
            self.id = id
            self.hardware = hardware
            self.codec = codec
            self.probe = probe
        }
    }

    public static func identity(
        liveCodecs: [String],
        h264EncoderID: String?,
        h264UsesHardware: Bool?,
        h264Probed: Bool
    ) -> Identity {
        // Nothing live means nothing to describe. The probe answers what this machine can do,
        // which is not the same claim.
        guard let codec = StreamCodecPolicy.dominant(liveCodecs) else {
            return Identity(id: nil, hardware: nil, codec: nil, probe: false)
        }
        // The probe describes an H.264 encoder; libwebrtc encodes VP8 and VP9 in software.
        guard StreamCodecPolicy.isH264(codec) else {
            return Identity(id: nil, hardware: false, codec: codec, probe: false)
        }
        // Forced H.264 skips the probe, and nothing else can say which encoder runs.
        guard h264Probed else {
            return Identity(id: nil, hardware: nil, codec: nil, probe: false)
        }
        return Identity(id: h264EncoderID, hardware: h264UsesHardware, codec: codec, probe: true)
    }
}
