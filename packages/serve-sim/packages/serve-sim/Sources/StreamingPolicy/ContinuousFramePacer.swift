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

    /// How the chain picks send times. `.grid` holds a fixed cadence grid, on its own clock: a
    /// 60 Hz source that jitters around a slot then repeats one frame and skips the next.
    /// `.bucket` caps the long-run rate with a token bucket refilled at `freshRateMultiplier` times
    /// the cadence; a fresh frame goes out on arrival while a token is left, so the send phase
    /// follows the source, and the previous frame repeats at the cadence once the source is idle.
    public enum Mode: Sendable { case grid, bucket }
    public let mode: Mode
    /// Two tokens absorb one interval of arrival jitter without letting the rate run ahead.
    private static let bucketCapacity: Double = 2
    /// While the source is active, a late fresh frame gets this long before the previous frame
    /// repeats: a repeat spends the token the late frame then has to wait for.
    private static let bucketActiveGraceIntervals: Double = 1.5
    /// How much faster than the cadence fresh frames may go out in `.bucket` mode. The cadence
    /// still sets repeats; above 1, a burst of fresh frames (a capture that fell behind and caught
    /// up) goes out whole instead of the newest replacing the middle one.
    public let freshRateMultiplier: Double
    private var tokens: Double = ContinuousFramePacer.bucketCapacity
    private var tokensRefilledAtNanoseconds: UInt64?

    private var schedulingToleranceNanoseconds: UInt64 {
        min(frameIntervalNanoseconds / 4, 5_000_000)
    }

    public init(framesPerSecond: Int, mode: Mode = .grid, freshRateMultiplier: Double = 1) {
        frameIntervalNanoseconds = Self.interval(framesPerSecond: framesPerSecond)
        self.mode = mode
        self.freshRateMultiplier = max(1, freshRateMultiplier)
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
            tokens = Self.bucketCapacity
            tokensRefilledAtNanoseconds = nil
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
        if mode == .bucket { return bucketArrival(atNanoseconds: now) }
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
        if mode == .bucket { return bucketTick(atNanoseconds: now) }
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

        // Advance to the next grid slot. If this send landed just beyond that
        // slot, advance one more interval instead of anchoring at `now`:
        // anchoring there schedules an immediate timer which must then wait a
        // full interval, leaving an idle source with two wakes per frame.
        // A longer stall still re-anchors without draining a catch-up burst.
        let cadenceAnchor = nextSendAtNanoseconds ?? now
        let nextGridSlot = cadenceAnchor &+ frameIntervalNanoseconds
        let nextSendAt: UInt64
        if nextGridSlot > now {
            nextSendAt = nextGridSlot
        } else if now - nextGridSlot < frameIntervalNanoseconds {
            nextSendAt = nextGridSlot &+ frameIntervalNanoseconds
        } else {
            nextSendAt = now
        }
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

    private mutating func bucketArrival(atNanoseconds now: UInt64) -> ArrivalDecision {
        refillTokens(atNanoseconds: now)
        if tokens >= 1 {
            return tickScheduled ? .pumpNow : startChain(atNanoseconds: now, afterNanoseconds: 0)
        }
        // Replaces the pending wake, which may be a later repeat deadline, with the next token. A
        // replacement is not a chained tick, so it leaves the watchdog's liveness clock alone.
        guard !tickScheduled else { return .schedule(nanoseconds: nanosecondsUntilToken()) }
        return startChain(atNanoseconds: now, afterNanoseconds: nanosecondsUntilToken())
    }

    private mutating func bucketTick(atNanoseconds now: UInt64) -> TickDecision {
        refillTokens(atNanoseconds: now)
        if !frameArrivedSinceSend {
            let due = bucketRepeatDue(atNanoseconds: now)
            if now < due { return .wait(nanoseconds: due - now) }
        }
        guard tokens >= 1 else { return .wait(nanoseconds: nanosecondsUntilToken()) }
        tokens -= 1
        if !frameArrivedSinceSend { repeatedSends &+= 1 }
        frameArrivedSinceSend = false
        lastSentAtNanoseconds = now
        let next = bucketRepeatDue(atNanoseconds: now)
        nextSendAtNanoseconds = next
        return .send(timestampNanoseconds: now, nextDelayNanoseconds: next > now ? next - now : 0)
    }

    private func bucketRepeatDue(atNanoseconds now: UInt64) -> UInt64 {
        guard let lastSentAtNanoseconds else { return now }
        let intervals = sourceHasCadence(atNanoseconds: now) ? Self.bucketActiveGraceIntervals : 1
        return lastSentAtNanoseconds &+ UInt64(Double(frameIntervalNanoseconds) * intervals)
    }

    private mutating func refillTokens(atNanoseconds now: UInt64) {
        guard let refilledAt = tokensRefilledAtNanoseconds else {
            tokensRefilledAtNanoseconds = now
            return
        }
        // Arrival and pump clocks are read on different queues; a slightly older reading adds nothing.
        guard now > refilledAt else { return }
        tokens = min(Self.bucketCapacity, tokens + Double(now - refilledAt) * freshRateMultiplier / Double(frameIntervalNanoseconds))
        tokensRefilledAtNanoseconds = now
    }

    private func nanosecondsUntilToken() -> UInt64 {
        tokens >= 1 ? 0 : UInt64((1 - tokens) * Double(frameIntervalNanoseconds) / freshRateMultiplier) + 1
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
