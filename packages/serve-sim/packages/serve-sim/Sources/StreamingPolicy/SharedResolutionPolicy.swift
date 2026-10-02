/// One resolution for every viewer of the shared H.264 encode, chosen from the
/// lowest bitrate any peer's congestion controller allows.
///
/// A sustained shortfall steps the canvas down. A longer period with headroom
/// steps it back up. After a peer joins or the canvas steps, the policy holds
/// still, so a ramping peer or a restarted encoder cannot bounce the canvas.
public struct SharedResolutionPolicy: Equatable, Sendable {
    /// Long-edge scales, largest first. The floor keeps UI text readable.
    public static let scales: [Double] = [1.0, 0.75, 0.5]
    public static let stepDownBelowFraction = 0.4
    public static let stepUpAboveFraction = 0.9
    public static let stepDownAfterNanoseconds: UInt64 = 2_000_000_000
    public static let stepUpAfterNanoseconds: UInt64 = 10_000_000_000
    public static let joinHoldNanoseconds: UInt64 = 5_000_000_000
    public static let stepHoldNanoseconds: UInt64 = 10_000_000_000

    public private(set) var step = 0
    public private(set) var changes: UInt64 = 0
    private var targetBitrate: Int
    private var holdUntilNanoseconds: UInt64 = 0
    private var shortfallSinceNanoseconds: UInt64?
    private var headroomSinceNanoseconds: UInt64?

    public var scale: Double { Self.scales[step] }

    public init(targetBitrate: Int) {
        self.targetBitrate = max(1, targetBitrate)
    }

    public mutating func setTargetBitrate(_ bitrate: Int) {
        targetBitrate = max(1, bitrate)
    }

    public mutating func peerJoined(atNanoseconds now: UInt64) {
        holdUntilNanoseconds = max(holdUntilNanoseconds, now &+ Self.joinHoldNanoseconds)
        shortfallSinceNanoseconds = nil
        headroomSinceNanoseconds = nil
    }

    /// Feeds the lowest peer bitrate. Returns true when the step changed.
    public mutating func observe(bitrate: Int, atNanoseconds now: UInt64) -> Bool {
        guard now >= holdUntilNanoseconds else {
            shortfallSinceNanoseconds = nil
            headroomSinceNanoseconds = nil
            return false
        }
        let ratio = Double(bitrate) / Double(targetBitrate)
        if ratio < Self.stepDownBelowFraction {
            headroomSinceNanoseconds = nil
            let since = shortfallSinceNanoseconds ?? now
            shortfallSinceNanoseconds = since
            guard step < Self.scales.count - 1, now &- since >= Self.stepDownAfterNanoseconds else {
                return false
            }
            step += 1
        } else if ratio > Self.stepUpAboveFraction {
            shortfallSinceNanoseconds = nil
            let since = headroomSinceNanoseconds ?? now
            headroomSinceNanoseconds = since
            guard step > 0, now &- since >= Self.stepUpAfterNanoseconds else { return false }
            step -= 1
        } else {
            shortfallSinceNanoseconds = nil
            headroomSinceNanoseconds = nil
            return false
        }
        changes &+= 1
        holdUntilNanoseconds = now &+ Self.stepHoldNanoseconds
        shortfallSinceNanoseconds = nil
        headroomSinceNanoseconds = nil
        return true
    }

    /// The long-edge limit for the canvas at `scale`: `baseLimit` (zero for native) scaled
    /// down. At full scale the base limit passes through unchanged.
    public static func canvasLongEdge(baseLimit: Int, sourceLongEdge: Int, scale: Double) -> Int {
        guard scale < 1 else { return baseLimit }
        let base = baseLimit > 0 ? baseLimit : sourceLongEdge
        return max(2, Int((Double(base) * scale).rounded()))
    }
}
