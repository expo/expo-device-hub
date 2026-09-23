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

    /// The codec to report for several sessions. H.264 wins so one software session cannot
    /// mask a live hardware one.
    public static func dominant(_ codecNames: [String]) -> String? {
        let named = codecNames.filter { !$0.isEmpty }
        return named.first(where: isH264) ?? named.first
    }

    /// `"video/H264"` -> `"H264"`. Nil for anything without a subtype.
    public static func codecName(fromMimeType mimeType: String) -> String? {
        let parts = mimeType.split(separator: "/", omittingEmptySubsequences: false)
        guard parts.count == 2, !parts[1].isEmpty else { return nil }
        return String(parts[1])
    }
}
