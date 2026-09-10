import Foundation

struct FrameRateGate {
    private var minimumIntervalNanoseconds: UInt64
    private var nextDeadlineNanoseconds: UInt64?

    init(fps: Int) {
        minimumIntervalNanoseconds = Self.interval(fps: fps)
    }

    mutating func update(fps: Int) {
        minimumIntervalNanoseconds = Self.interval(fps: fps)
        nextDeadlineNanoseconds = nil
    }

    mutating func shouldEncode() -> Bool {
        let now = DispatchTime.now().uptimeNanoseconds
        guard let deadline = nextDeadlineNanoseconds else {
            nextDeadlineNanoseconds = now &+ minimumIntervalNanoseconds
            return true
        }
        // Display callbacks are not phase-locked to this queue. A strict
        // elapsed check can reject every nominal 60 Hz frame that arrives a
        // fraction early and collapse the stream to 30 Hz.
        let tolerance = min(minimumIntervalNanoseconds / 10, 2_000_000)
        if now &+ tolerance < deadline {
            return false
        }
        nextDeadlineNanoseconds = max(
            deadline &+ minimumIntervalNanoseconds,
            now &+ minimumIntervalNanoseconds
        )
        return true
    }

    private static func interval(fps: Int) -> UInt64 {
        1_000_000_000 / UInt64(max(1, fps))
    }
}
