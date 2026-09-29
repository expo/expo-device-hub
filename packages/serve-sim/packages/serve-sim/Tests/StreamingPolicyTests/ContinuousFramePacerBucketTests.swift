import XCTest
@testable import StreamingPolicy

final class ContinuousFramePacerBucketTests: XCTestCase {
    func testLateFrameGoesOutOnArrivalInsteadOfARepeat() {
        var pacer = ContinuousFramePacer(framesPerSecond: 60, mode: .bucket)
        pacer.setActive(true)
        XCTAssertEqual(pacer.latestFrameArrived(atNanoseconds: 0), .schedule(nanoseconds: 0))
        XCTAssertEqual(pacer.tick(atNanoseconds: 0),
                       .send(timestampNanoseconds: 0, nextDelayNanoseconds: 16_666_666))
        // An on-time second frame gives the source a cadence, so the chain allows 1.5 intervals.
        XCTAssertEqual(pacer.latestFrameArrived(atNanoseconds: 16_666_666), .pumpNow)
        XCTAssertEqual(pacer.tick(atNanoseconds: 16_666_666, chained: false),
                       .send(timestampNanoseconds: 16_666_666, nextDelayNanoseconds: 24_999_999))
        XCTAssertEqual(pacer.tick(atNanoseconds: 16_666_666), .wait(nanoseconds: 24_999_999))

        // The third frame lands 5 ms after the grid slot, past the grid's one-tolerance wait.
        // It goes out when it arrives, and the previous frame never repeats.
        XCTAssertEqual(pacer.latestFrameArrived(atNanoseconds: 38_333_332), .pumpNow)
        XCTAssertEqual(pacer.tick(atNanoseconds: 38_333_332, chained: false),
                       .send(timestampNanoseconds: 38_333_332, nextDelayNanoseconds: 24_999_999))
        XCTAssertEqual(pacer.repeatedSends, 0)
    }

    /// Sends in one second from a source arriving every `interval`, driven the way the publisher
    /// drives the pacer.
    private func sendsInOneSecond(_ pacer: inout ContinuousFramePacer, arrivalEvery interval: UInt64) -> Int {
        pacer.setActive(true)
        let end: UInt64 = 1_000_000_000
        var arrival: UInt64 = 0
        var timer: UInt64?
        var sends = 0
        while true {
            let nextArrival = arrival <= end ? arrival : .max
            let nextTimer = timer.map { $0 <= end ? $0 : .max } ?? .max
            if nextArrival == .max && nextTimer == .max { break }
            if nextArrival <= nextTimer {
                switch pacer.latestFrameArrived(atNanoseconds: nextArrival) {
                case .pumpNow:
                    if case .send = pacer.tick(atNanoseconds: nextArrival, chained: false) { sends += 1 }
                case let .schedule(delay), let .restart(delay):
                    timer = nextArrival + delay
                case .ignore:
                    break
                }
                arrival += interval
            } else {
                timer = nil
                switch pacer.tick(atNanoseconds: nextTimer) {
                case let .send(_, next):
                    sends += 1
                    timer = nextTimer + next
                case let .wait(delay):
                    timer = nextTimer + delay
                case .stop:
                    XCTFail("unexpected stop")
                    return sends
                }
            }
        }
        return sends
    }

    func testFastSourceStillSendsAtTheCadence() {
        var pacer = ContinuousFramePacer(framesPerSecond: 60, mode: .bucket)
        let sends = sendsInOneSecond(&pacer, arrivalEvery: 8_333_333)
        // 60 a second, plus at most the two tokens the bucket starts with.
        XCTAssertGreaterThanOrEqual(sends, 59)
        XCTAssertLessThanOrEqual(sends, 62)
    }

    func testFreshRateMultiplierCapsAFastSource() {
        // The publisher's multiplier: a 120 Hz source at 60 gets 1.5 times 60, not 120.
        var pacer = ContinuousFramePacer(framesPerSecond: 60, mode: .bucket, freshRateMultiplier: 1.5)
        let sends = sendsInOneSecond(&pacer, arrivalEvery: 8_333_333)
        XCTAssertGreaterThanOrEqual(sends, 89)
        XCTAssertLessThanOrEqual(sends, 92)
    }

    func testFreshRateMultiplierLetsABurstThrough() {
        // Three fresh frames within 12 ms, as a capture sends them after a late copy.
        func burst(_ multiplier: Double) -> Bool {
            var pacer = ContinuousFramePacer(framesPerSecond: 60, mode: .bucket, freshRateMultiplier: multiplier)
            pacer.setActive(true)
            XCTAssertEqual(pacer.latestFrameArrived(atNanoseconds: 0), .schedule(nanoseconds: 0))
            XCTAssertEqual(pacer.tick(atNanoseconds: 0), .send(timestampNanoseconds: 0, nextDelayNanoseconds: 16_666_666))
            XCTAssertEqual(pacer.latestFrameArrived(atNanoseconds: 5_000_000), .pumpNow)
            guard case .send = pacer.tick(atNanoseconds: 5_000_000, chained: false) else { return false }
            guard pacer.latestFrameArrived(atNanoseconds: 12_000_000) == .pumpNow,
                  case .send = pacer.tick(atNanoseconds: 12_000_000, chained: false) else { return false }
            return true
        }
        XCTAssertFalse(burst(1), "at the cadence the third frame waits, and the next one replaces it")
        XCTAssertTrue(burst(1.5))
    }

    func testTokenWaitsDoNotHideALostChain() {
        var pacer = ContinuousFramePacer(framesPerSecond: 60, mode: .bucket, freshRateMultiplier: 1.5)
        pacer.setActive(true)
        XCTAssertEqual(pacer.latestFrameArrived(atNanoseconds: 0), .schedule(nanoseconds: 0))
        // The chained tick never fires. A 240 Hz source keeps arriving, and its arrival-driven
        // sends spend the tokens, so later arrivals wait for a token.
        var restartedAt: UInt64?
        var now: UInt64 = 4_166_666
        while now < 250_000_000, restartedAt == nil {
            switch pacer.latestFrameArrived(atNanoseconds: now) {
            case .pumpNow: _ = pacer.tick(atNanoseconds: now, chained: false)
            case .restart: restartedAt = now
            case .schedule, .ignore: break
            }
            now += 4_166_666
        }
        // Four intervals without a chained tick mark the chain lost.
        XCTAssertNotNil(restartedAt, "waiting for a token must not count as a chained tick")
        XCTAssertLessThanOrEqual(restartedAt ?? .max, 75_000_000)
    }

    func testIdleScreenRepeatsAtTheCadence() {
        var pacer = ContinuousFramePacer(framesPerSecond: 60, mode: .bucket)
        pacer.setActive(true)
        XCTAssertEqual(pacer.latestFrameArrived(atNanoseconds: 0), .schedule(nanoseconds: 0))
        XCTAssertEqual(pacer.tick(atNanoseconds: 0),
                       .send(timestampNanoseconds: 0, nextDelayNanoseconds: 16_666_666))
        var now: UInt64 = 16_666_666
        var sends = 0
        var waits = 0
        while now < 200_000_000 {
            switch pacer.tick(atNanoseconds: now) {
            case let .send(_, next):
                sends += 1
                now += next
            case let .wait(delay):
                waits += 1
                now += delay
            case .stop:
                XCTFail("unexpected stop")
                return
            }
        }
        XCTAssertEqual(waits, 0)
        XCTAssertGreaterThanOrEqual(sends, 10, "the idle screen still streams at the cadence")
        XCTAssertEqual(pacer.repeatedSends, UInt64(sends))
    }
}
