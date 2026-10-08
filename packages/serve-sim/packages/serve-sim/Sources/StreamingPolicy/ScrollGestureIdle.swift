/// Only the latest wheel activity may release its drag. Cancellation alone
/// cannot protect a new gesture from an idle callback already queued to run.
public struct ScrollGestureIdle: Sendable {
    public private(set) var isActive = false
    public private(set) var gestureGeneration: UInt64 = 0
    private var generation: UInt64 = 0
    private var selectedScreenID: UInt32?

    public init() {}

    /// Returns whether a wheel drag must lift before the selected panel changes.
    public mutating func selectScreen(_ screenID: UInt32?) -> Bool {
        guard selectedScreenID != screenID else { return false }
        selectedScreenID = screenID
        return interrupt()
    }

    public mutating func extend() -> UInt64 {
        if !isActive { gestureGeneration &+= 1 }
        generation &+= 1
        isActive = true
        return generation
    }

    /// Returns whether the interrupted wheel drag needs a touch-up.
    public mutating func interrupt() -> Bool {
        let wasActive = isActive
        generation &+= 1
        isActive = false
        return wasActive
    }

    public mutating func expire(_ pending: UInt64) -> Bool {
        guard isCurrent(pending) else { return false }
        return interrupt()
    }

    public func isCurrent(_ pending: UInt64) -> Bool {
        isActive && generation == pending
    }

    public func isCurrentGesture(_ pending: UInt64) -> Bool {
        isActive && gestureGeneration == pending
    }
}
