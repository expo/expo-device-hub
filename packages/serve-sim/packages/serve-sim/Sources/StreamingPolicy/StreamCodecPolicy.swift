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

    /// The first media payload in the active video answer is the selected codec preference.
    public static func firstVideoCodecName(in sdp: String) -> String? {
        let sections = sdp.components(separatedBy: "\nm=")
        for section in sections {
            let lines = section.split(whereSeparator: \.isNewline)
            guard let header = lines.first else { continue }
            let fields = header.replacingOccurrences(of: "m=", with: "").split(separator: " ")
            guard fields.count > 3, fields[0] == "video", fields[1] != "0" else { continue }
            for payload in fields.dropFirst(3) {
                let prefix = "a=rtpmap:\(payload) "
                guard let mapping = lines.first(where: { $0.hasPrefix(prefix) }) else { continue }
                let name = mapping.dropFirst(prefix.count).split(separator: "/", maxSplits: 1).first.map(String.init)
                if let name, let media = mediaCodecName(from: [name]) { return media }
            }
        }
        return nil
    }
}
