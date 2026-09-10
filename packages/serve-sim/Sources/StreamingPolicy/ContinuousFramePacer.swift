public struct ContinuousFramePacer: Sendable {
    public enum ArrivalDecision: Equatable, Sendable {
        case ignore
        case pumpNow
        case schedule(nanoseconds: UInt64)
        /// The scheduled pump has not ticked for several intervals and is
        /// presumed lost. The owner must invalidate any zombie pump (bump its
        /// generation) and schedule a fresh chain after the given delay.
        case restart(nanoseconds: UInt64)
    }

    public enum TickDecision: Equatable, Sendable {
        case stop
        case wait(nanoseconds: UInt64)
        case send(timestampNanoseconds: UInt64, nextDelayNanoseconds: UInt64)
    }

    /// How many silent intervals a scheduled chain gets before an arrival may
    /// reclaim it as lost. Unchained (arrival-driven) ticks do not count as
    /// liveness — a dead chain with arrivals still flowing is exactly the
    /// degraded state this guards against.
    private static let lostPumpGraceIntervals: UInt64 = 4

    private var frameIntervalNanoseconds: UInt64
    private var active = false
    private var hasFrame = false
    private var tickScheduled = false
    private var lastSentAtNanoseconds: UInt64?
    private var nextSendAtNanoseconds: UInt64?
    /// Last proof the scheduled chain exists: arming an initial or replacement
    /// pump, or any chained tick (send or wait).
    private var chainSeenAtNanoseconds: UInt64?

    private var schedulingToleranceNanoseconds: UInt64 {
        min(frameIntervalNanoseconds / 4, 5_000_000)
    }

    public init(framesPerSecond: Int) {
        frameIntervalNanoseconds = Self.interval(framesPerSecond: framesPerSecond)
    }

    /// Updates the sole configured output cadence. When `now` is supplied,
    /// the returned delay lets the owner replace its pending timer instead of
    /// waiting for a callback scheduled at the previous, slower rate.
    @discardableResult
    public mutating func update(
        framesPerSecond: Int,
        atNanoseconds now: UInt64? = nil
    ) -> UInt64? {
        frameIntervalNanoseconds = Self.interval(framesPerSecond: framesPerSecond)
        if let lastSentAtNanoseconds {
            nextSendAtNanoseconds = lastSentAtNanoseconds &+ frameIntervalNanoseconds
        }
        guard active, hasFrame, let now else {
            return nil
        }
        // The owner arms a replacement pump with the returned delay.
        chainSeenAtNanoseconds = now
        guard let nextSendAtNanoseconds else { return 0 }
        return nextSendAtNanoseconds > now ? nextSendAtNanoseconds - now : 0
    }

    public mutating func setActive(_ active: Bool) {
        guard self.active != active else { return }
        self.active = active
        if !active {
            hasFrame = false
            tickScheduled = false
            lastSentAtNanoseconds = nil
            nextSendAtNanoseconds = nil
            chainSeenAtNanoseconds = nil
        }
    }

    public mutating func latestFrameArrived(atNanoseconds now: UInt64) -> ArrivalDecision {
        guard active else { return .ignore }
        hasFrame = true
        if lostPump(atNanoseconds: now) {
            chainSeenAtNanoseconds = now
            return .restart(nanoseconds: 0)
        }
        guard nextSendAtNanoseconds != nil || lastSentAtNanoseconds != nil else {
            guard !tickScheduled else { return .ignore }
            tickScheduled = true
            chainSeenAtNanoseconds = now
            return .schedule(nanoseconds: 0)
        }
        guard let earliest = earliestSendNanoseconds() else {
            return tickScheduled ? .pumpNow : startChain(atNanoseconds: now, afterNanoseconds: 0)
        }
        guard now &+ schedulingToleranceNanoseconds < earliest else {
            return tickScheduled ? .pumpNow : startChain(atNanoseconds: now, afterNanoseconds: 0)
        }
        guard !tickScheduled else { return .ignore }
        return startChain(atNanoseconds: now, afterNanoseconds: earliest - now)
    }

    public mutating func tick(atNanoseconds now: UInt64, chained: Bool = true) -> TickDecision {
        guard active, hasFrame else {
            tickScheduled = false
            chainSeenAtNanoseconds = nil
            return .stop
        }
        if chained {
            chainSeenAtNanoseconds = now
        }
        let toleratedNow = now &+ schedulingToleranceNanoseconds
        if let earliest = earliestSendNanoseconds(), toleratedNow < earliest {
            return .wait(nanoseconds: earliest - now)
        }

        // Advance to the next grid slot, but never into the past: a late
        // wake-up must not skip cadence slots (consistently late timers on a
        // virtualized host would halve the rate), and a stall longer than an
        // interval re-anchors to `now` instead of draining a catch-up burst —
        // the one-interval spacing floor in `earliestSendNanoseconds` keeps
        // consecutive sends apart either way.
        let cadenceAnchor = nextSendAtNanoseconds ?? now
        let nextSendAt = max(cadenceAnchor &+ frameIntervalNanoseconds, now)
        lastSentAtNanoseconds = now
        nextSendAtNanoseconds = nextSendAt
        return .send(
            timestampNanoseconds: now,
            nextDelayNanoseconds: nextSendAt > now ? nextSendAt - now : 0
        )
    }

    private mutating func startChain(
        atNanoseconds now: UInt64,
        afterNanoseconds delay: UInt64
    ) -> ArrivalDecision {
        tickScheduled = true
        chainSeenAtNanoseconds = now
        return .schedule(nanoseconds: delay)
    }

    /// True when a chain is supposedly scheduled but no chained tick has fired
    /// for the whole grace window.
    private func lostPump(atNanoseconds now: UInt64) -> Bool {
        guard tickScheduled, let chainSeenAtNanoseconds else { return false }
        let grace = frameIntervalNanoseconds &* Self.lostPumpGraceIntervals
        return now > chainSeenAtNanoseconds &+ grace
    }

    private func earliestSendNanoseconds() -> UInt64? {
        var earliest = nextSendAtNanoseconds
        if let lastSentAtNanoseconds {
            let spacedSend = lastSentAtNanoseconds &+ frameIntervalNanoseconds
            earliest = max(earliest ?? spacedSend, spacedSend)
        }
        return earliest
    }

    private static func interval(framesPerSecond: Int) -> UInt64 {
        1_000_000_000 / UInt64(max(1, framesPerSecond))
    }
}
