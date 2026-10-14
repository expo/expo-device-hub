// @ref LLP 0001#capture-recovery — after the first frame, recovery follows surface loss, not unchanged pixels.
public struct FramebufferSurfaceWatch: Sendable {
    public enum Action: Equatable, Sendable {
        case none
        /// `lossStarted` marks the first re-wire of a loss after the first frame.
        case rewire(lossStarted: Bool)
    }

    private let intervalNanoseconds: UInt64
    private var lastSurfaceNanoseconds: UInt64
    private var lastRewireNanoseconds: UInt64
    private var lossStartNanoseconds: UInt64?
    private var rewiredCurrentLoss = false
    private var endedLossNanoseconds: UInt64 = 0
    public private(set) var losses: UInt64 = 0
    public private(set) var rewires: UInt64 = 0

    public init(startNanoseconds: UInt64, intervalNanoseconds: UInt64 = 1_000_000_000) {
        self.intervalNanoseconds = intervalNanoseconds
        lastSurfaceNanoseconds = startNanoseconds
        lastRewireNanoseconds = startNanoseconds
    }

    public mutating func surfaceFound(atNanoseconds now: UInt64) -> UInt64? {
        lastSurfaceNanoseconds = now
        guard let start = lossStartNanoseconds else { return nil }
        lossStartNanoseconds = nil
        rewiredCurrentLoss = false
        let lasted = Self.elapsed(from: start, to: now)
        endedLossNanoseconds &+= lasted
        return lasted
    }

    /// `deviceBooted` is read only when a re-wire is due, so at most once per interval.
    public mutating func tick(atNanoseconds now: UInt64, capturedAnyFrame: Bool,
                              deviceBooted: @autoclosure () -> Bool = true) -> Action {
        let surfaceMissing = !capturedAnyFrame || Self.elapsed(from: lastSurfaceNanoseconds, to: now) >= intervalNanoseconds
        guard surfaceMissing, Self.elapsed(from: lastRewireNanoseconds, to: now) >= intervalNanoseconds else {
            return .none
        }
        lastRewireNanoseconds = now
        if capturedAnyFrame, lossStartNanoseconds == nil {
            lossStartNanoseconds = lastSurfaceNanoseconds
            losses &+= 1
        }
        // A simulator that is not booted has no display pipeline to wire, and every
        // attempt leaves ROCKit proxies behind that are never released. The loss
        // still counts; only the re-wire waits for the boot.
        guard deviceBooted() else { return .none }
        rewires &+= 1
        guard capturedAnyFrame, !rewiredCurrentLoss else { return .rewire(lossStarted: false) }
        rewiredCurrentLoss = true
        return .rewire(lossStarted: true)
    }

    public func currentLossNanoseconds(atNanoseconds now: UInt64) -> UInt64 {
        lossStartNanoseconds.map { Self.elapsed(from: $0, to: now) } ?? 0
    }

    /// Cumulative loss time after the first frame, including an ongoing loss.
    public func lostNanoseconds(atNanoseconds now: UInt64) -> UInt64 {
        endedLossNanoseconds &+ currentLossNanoseconds(atNanoseconds: now)
    }

    private static func elapsed(from start: UInt64, to now: UInt64) -> UInt64 {
        now >= start ? now - start : 0
    }
}
