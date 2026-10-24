/// Only an authoritatively inactive Duo panel is limited to a keepalive cadence.
/// A motionless active panel and an unknown activity state retain normal cadence.
public struct PanelFrameCadence: Sendable {
    public private(set) var skippedRepeats: UInt64 = 0
    private var active: Bool?
    private var requested = true
    private var lastSentNs: UInt64?
    private static let inactiveIntervalNs: UInt64 = 200_000_000

    public init() {}
    public mutating func setActive(_ active: Bool?) { self.active = active }
    public mutating func requestFrame() { requested = true }

    public mutating func shouldSend(atNanoseconds now: UInt64) -> Bool {
        if active == false, !requested, let lastSentNs,
           now >= lastSentNs, now - lastSentNs < Self.inactiveIntervalNs {
            skippedRepeats &+= 1
            return false
        }
        requested = false
        lastSentNs = now
        return true
    }
}
