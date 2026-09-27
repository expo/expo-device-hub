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
    /// A source has a cadence when its last two frames arrived less than this many
    /// intervals apart and the last one is younger than that. Only such a source
    /// earns a deferral; an idle screen repeats at the cadence as before.
    private static let activeSourceIntervals: UInt64 = 2

    /// Chained ticks that waited one tolerance for a frame that had not arrived yet.
    public private(set) var deferredTicks: UInt64 = 0
    /// Sends that repeated the frame sent before.
    public private(set) var repeatedSends: UInt64 = 0

    private var frameIntervalNanoseconds: UInt64
    private var active = false
    private var hasFrame = false
    private var tickScheduled = false
    private var lastSentAtNanoseconds: UInt64?
    private var nextSendAtNanoseconds: UInt64?
    /// Last proof the scheduled chain exists: arming an initial or replacement
    /// pump, or any chained tick (send or wait).
    private var chainSeenAtNanoseconds: UInt64?
    private var lastArrivalNanoseconds: UInt64?
    private var previousArrivalNanoseconds: UInt64?
    private var frameArrivedSinceSend = false
    private var deferredThisSlot = false

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
            lastArrivalNanoseconds = nil
            previousArrivalNanoseconds = nil
            frameArrivedSinceSend = false
            deferredThisSlot = false
        }
    }

    public mutating func latestFrameArrived(atNanoseconds now: UInt64) -> ArrivalDecision {
        guard active else { return .ignore }
        hasFrame = true
        previousArrivalNanoseconds = lastArrivalNanoseconds
        lastArrivalNanoseconds = now
        frameArrivedSinceSend = true
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

        // A 60 Hz source often lands a fraction of a millisecond after the slot.
        // Sending the old frame then repeats it, and the fresh frame is skipped
        // by the one the next slot picks. Wait one tolerance for it instead, once
        // per slot, and only while the source is active.
        if chained, !frameArrivedSinceSend, !deferredThisSlot, sourceHasCadence(atNanoseconds: now) {
            deferredThisSlot = true
            deferredTicks &+= 1
            return .wait(nanoseconds: schedulingToleranceNanoseconds)
        }
        if !frameArrivedSinceSend { repeatedSends &+= 1 }
        frameArrivedSinceSend = false
        deferredThisSlot = false

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

    private func sourceHasCadence(atNanoseconds now: UInt64) -> Bool {
        guard let last = lastArrivalNanoseconds, let previous = previousArrivalNanoseconds else {
            return false
        }
        let window = frameIntervalNanoseconds &* Self.activeSourceIntervals
        return last &- previous < window && now &- last < window
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
