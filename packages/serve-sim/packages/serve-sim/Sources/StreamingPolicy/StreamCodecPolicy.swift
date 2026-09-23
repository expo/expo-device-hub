import Foundation

/// Reading codec names: what they mean, and which one out of a negotiated list.
public enum StreamCodecPolicy {
    public static func isH264(_ codecName: String) -> Bool {
        codecName.caseInsensitiveCompare("H264") == .orderedSame
    }

    /// Retransmission and error correction ride in the same negotiated codec list as the
    /// media codec, in no guaranteed order.
    private static let auxiliaryNames: Set<String> = ["rtx", "red", "ulpfec", "flexfec-03"]

    /// The media codec out of a negotiated list. Nil when the list carries nothing but
    /// auxiliary entries, where the caller's own requested name is the better answer.
    public static func mediaCodecName(from codecNames: [String]) -> String? {
        codecNames.first { !auxiliaryNames.contains($0.lowercased()) }
    }
}
