/// The deadline grid a repeating timer fires on, so a wake is measured against the slot it was
/// aiming for rather than against the previous wake.
///
/// A repeating `DispatchSourceTimer` keeps firing on its original grid even when handlers are
/// blocked and fires coalesce. Catching up to an arbitrary `now` would move the accounting off
/// that grid, after which every real wake arrives early and lateness reads zero forever.
public struct PollDeadlineGrid: Sendable {
    private let intervalNanoseconds: UInt64
    private var deadlineNanoseconds: UInt64

    /// `firstDeadlineNanoseconds` must be the deadline the timer itself is scheduled on. Seeding
    /// it further ahead than one interval leaves the grid permanently behind the timer.
    public init(firstDeadlineNanoseconds: UInt64, intervalNanoseconds: UInt64) {
        self.deadlineNanoseconds = firstDeadlineNanoseconds
        self.intervalNanoseconds = intervalNanoseconds
    }

    /// Advances to the first slot after `now` and returns how late this wake was.
    public mutating func wake(atNanoseconds now: UInt64) -> UInt64 {
        guard intervalNanoseconds > 0 else { return 0 }
        let deadline = deadlineNanoseconds
        guard now > deadline else {
            deadlineNanoseconds = deadline &+ intervalNanoseconds
            return 0
        }
        let behind = now - deadline
        // Masking arithmetic only to avoid a trap in a hot path; `behind` would need 585 years
        // of uptime to reach the wrapping point.
        let steps = behind / intervalNanoseconds &+ 1
        deadlineNanoseconds = deadline &+ steps &* intervalNanoseconds
        return behind
    }
}
