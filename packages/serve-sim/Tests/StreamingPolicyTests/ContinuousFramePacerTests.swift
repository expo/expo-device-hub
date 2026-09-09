import XCTest
@testable import StreamingPolicy

final class ContinuousFramePacerTests: XCTestCase {
    func testDueCaptureArrivalCanWakeTheSixtyFpsSlotWithoutStartingAnotherCadence() {
        var pacer = ContinuousFramePacer(framesPerSecond: 60)
        pacer.setActive(true)

        XCTAssertEqual(
            pacer.latestFrameArrived(atNanoseconds: 0),
            .schedule(nanoseconds: 0)
        )
        XCTAssertEqual(
            pacer.tick(atNanoseconds: 0),
            .send(timestampNanoseconds: 0, nextDelayNanoseconds: 16_666_666)
        )

        // A real 60 Hz capture commonly arrives just before the timer deadline.
        // It should wake this same slot immediately, not wait for another interval.
        XCTAssertEqual(
            pacer.latestFrameArrived(atNanoseconds: 13_000_000),
            .pumpNow
        )
        XCTAssertEqual(
            pacer.tick(atNanoseconds: 13_000_000),
            .send(timestampNanoseconds: 13_000_000, nextDelayNanoseconds: 20_333_332)
        )
    }

    func testSustainedSlightlyEarlySixtyHzArrivalsDoNotCollapseToAlternateSlots() {
        var pacer = ContinuousFramePacer(framesPerSecond: 60)
        pacer.setActive(true)
        var nextChainedTick: UInt64?
        var latestFrameIndex = -1
        var submittedFrameIndexes: [Int] = []

        func runChainedTick(at nanoseconds: UInt64) {
            switch pacer.tick(atNanoseconds: nanoseconds) {
            case let .send(_, nextDelayNanoseconds):
                submittedFrameIndexes.append(latestFrameIndex)
                nextChainedTick = nanoseconds + nextDelayNanoseconds
            case let .wait(delayNanoseconds):
                nextChainedTick = nanoseconds + delayNanoseconds
            case .stop:
                nextChainedTick = nil
            }
        }

        for frameIndex in 0 ... 60 {
            // Model a capture callback that wakes 3.67 ms before each ideal
            // display slot. The old independently timed gates accepted only
            // every other callback and produced roughly 30-40 FPS.
            let arrivalNanoseconds = frameIndex == 0
                ? 0
                : UInt64(frameIndex) * 16_666_666 - 3_666_666

            while let tickNanoseconds = nextChainedTick,
                  tickNanoseconds < arrivalNanoseconds {
                runChainedTick(at: tickNanoseconds)
            }

            latestFrameIndex = frameIndex
            switch pacer.latestFrameArrived(atNanoseconds: arrivalNanoseconds) {
            case let .schedule(delayNanoseconds):
                nextChainedTick = arrivalNanoseconds + delayNanoseconds
            case .pumpNow:
                guard case .send = pacer.tick(atNanoseconds: arrivalNanoseconds) else {
                    return XCTFail("A due capture should claim its cadence slot")
                }
                submittedFrameIndexes.append(latestFrameIndex)
            case .ignore:
                XCTFail("Capture frame \(frameIndex) was skipped")
            case .restart:
                XCTFail("A live chain must not be reclaimed")
            }
        }

        XCTAssertEqual(submittedFrameIndexes, Array(0 ... 60))
    }

    func testRepeatsTheLatestFrameAtTheConfiguredCadence() {
        var pacer = ContinuousFramePacer(framesPerSecond: 60)
        pacer.setActive(true)

        XCTAssertEqual(pacer.latestFrameArrived(atNanoseconds: 1_000), .schedule(nanoseconds: 0))
        XCTAssertEqual(
            pacer.tick(atNanoseconds: 1_000),
            .send(timestampNanoseconds: 1_000, nextDelayNanoseconds: 16_666_666)
        )
        XCTAssertEqual(
            pacer.tick(atNanoseconds: 16_667_666),
            .send(timestampNanoseconds: 16_667_666, nextDelayNanoseconds: 16_666_666)
        )
    }

    func testLateTicksKeepTheAbsoluteCadenceInsteadOfAccumulatingDrift() {
        var pacer = ContinuousFramePacer(framesPerSecond: 60)
        pacer.setActive(true)
        XCTAssertEqual(pacer.latestFrameArrived(atNanoseconds: 0), .schedule(nanoseconds: 0))
        XCTAssertEqual(
            pacer.tick(atNanoseconds: 0),
            .send(timestampNanoseconds: 0, nextDelayNanoseconds: 16_666_666)
        )

        XCTAssertEqual(
            pacer.tick(atNanoseconds: 20_000_000),
            .send(timestampNanoseconds: 20_000_000, nextDelayNanoseconds: 13_333_332)
        )
    }

    func testLateSendDoesNotAllowABackToBackArrivalSubmission() {
        var pacer = ContinuousFramePacer(framesPerSecond: 60)
        pacer.setActive(true)
        XCTAssertEqual(pacer.latestFrameArrived(atNanoseconds: 0), .schedule(nanoseconds: 0))
        _ = pacer.tick(atNanoseconds: 0)
        _ = pacer.tick(atNanoseconds: 29_170_000)

        XCTAssertEqual(
            pacer.latestFrameArrived(atNanoseconds: 29_200_000),
            .ignore
        )

        // Tolerance is applied once. A late send must not make the next slot
        // eligible only half an interval later: the next send is due one full
        // interval after the late one.
        XCTAssertEqual(
            pacer.tick(atNanoseconds: 37_503_334),
            .wait(nanoseconds: 8_333_332)
        )
    }

    func testTicksArrivingConsistentlyLateHoldTheConfiguredRate() {
        var pacer = ContinuousFramePacer(framesPerSecond: 60)
        pacer.setActive(true)
        XCTAssertEqual(pacer.latestFrameArrived(atNanoseconds: 0), .schedule(nanoseconds: 0))

        // Every wake-up lands 14 ms late — routine for coalesced timers on a
        // virtualized host. The old catch-up skipped every other cadence slot
        // and halved the rate to ~30 fps; the grid must instead keep sending
        // once per interval at a constant phase offset.
        let latenessNanoseconds: UInt64 = 14_000_000
        var wake: UInt64 = 0
        var sends = 0
        var lastTimestamp: UInt64 = 0
        for _ in 0 ..< 61 {
            switch pacer.tick(atNanoseconds: wake) {
            case let .send(timestampNanoseconds, nextDelayNanoseconds):
                sends += 1
                lastTimestamp = timestampNanoseconds
                wake = wake + nextDelayNanoseconds + latenessNanoseconds
            case let .wait(delayNanoseconds):
                wake = wake + delayNanoseconds + latenessNanoseconds
            case .stop:
                return XCTFail("The pump must stay active")
            }
        }
        XCTAssertGreaterThanOrEqual(sends, 59)
        // 59+ sends inside roughly one second proves the rate held.
        XCTAssertLessThanOrEqual(lastTimestamp, 1_050_000_000)
    }

    func testAStallLongerThanAnIntervalReanchorsWithoutASendBurst() {
        var pacer = ContinuousFramePacer(framesPerSecond: 60)
        pacer.setActive(true)
        XCTAssertEqual(pacer.latestFrameArrived(atNanoseconds: 0), .schedule(nanoseconds: 0))
        XCTAssertEqual(
            pacer.tick(atNanoseconds: 0),
            .send(timestampNanoseconds: 0, nextDelayNanoseconds: 16_666_666)
        )

        // An ~83 ms stall: one catch-up send fires immediately, re-anchored to
        // now, and the slot after it waits a full interval — a stall must not
        // drain a burst of queued slots into the encoder.
        XCTAssertEqual(
            pacer.tick(atNanoseconds: 100_000_000),
            .send(timestampNanoseconds: 100_000_000, nextDelayNanoseconds: 0)
        )
        XCTAssertEqual(
            pacer.tick(atNanoseconds: 100_000_100),
            .wait(nanoseconds: 16_666_566)
        )
    }

    func testALostPumpIsReclaimedByALaterArrival() {
        var pacer = ContinuousFramePacer(framesPerSecond: 60)
        pacer.setActive(true)
        XCTAssertEqual(pacer.latestFrameArrived(atNanoseconds: 0), .schedule(nanoseconds: 0))
        XCTAssertEqual(
            pacer.tick(atNanoseconds: 0),
            .send(timestampNanoseconds: 0, nextDelayNanoseconds: 16_666_666)
        )

        // The scheduled pump never fires again (a dropped or starved timer).
        // Due arrivals keep draining as unchained pumps, which must not count
        // as chain liveness — production showed exactly this state: arrivals
        // flowing, repeats absent.
        XCTAssertEqual(pacer.latestFrameArrived(atNanoseconds: 20_000_000), .pumpNow)
        XCTAssertEqual(
            pacer.tick(atNanoseconds: 20_000_000, chained: false),
            .send(timestampNanoseconds: 20_000_000, nextDelayNanoseconds: 13_333_332)
        )
        XCTAssertEqual(pacer.latestFrameArrived(atNanoseconds: 40_000_000), .pumpNow)

        // Past the grace window the next arrival reclaims the lost pump so the
        // owner can start a replacement chain under a fresh generation.
        XCTAssertEqual(
            pacer.latestFrameArrived(atNanoseconds: 70_000_000),
            .restart(nanoseconds: 0)
        )
        // The replacement chain re-anchors like a stall: one immediate send,
        // then normal spacing.
        XCTAssertEqual(
            pacer.tick(atNanoseconds: 70_000_100),
            .send(timestampNanoseconds: 70_000_100, nextDelayNanoseconds: 0)
        )
        XCTAssertEqual(
            pacer.tick(atNanoseconds: 70_000_200),
            .wait(nanoseconds: 16_666_566)
        )
    }

    func testAHealthyChainIsNotReclaimed() {
        var pacer = ContinuousFramePacer(framesPerSecond: 60)
        pacer.setActive(true)
        XCTAssertEqual(pacer.latestFrameArrived(atNanoseconds: 0), .schedule(nanoseconds: 0))
        _ = pacer.tick(atNanoseconds: 0)

        // Chained ticks keep proving liveness, so a late-but-alive chain is
        // never restarted from the arrival side.
        _ = pacer.tick(atNanoseconds: 33_400_000)
        _ = pacer.tick(atNanoseconds: 66_800_000)
        XCTAssertEqual(
            pacer.latestFrameArrived(atNanoseconds: 100_000_000),
            .pumpNow
        )
    }

    func testUpdatingFrameRateReanchorsFromThePreviousSubmission() {
        var pacer = ContinuousFramePacer(framesPerSecond: 24)
        pacer.setActive(true)
        XCTAssertEqual(pacer.latestFrameArrived(atNanoseconds: 0), .schedule(nanoseconds: 0))
        _ = pacer.tick(atNanoseconds: 0)

        let replacementDelay = pacer.update(
            framesPerSecond: 60,
            atNanoseconds: 10_000_000
        )

        XCTAssertEqual(replacementDelay, 6_666_666)

        XCTAssertEqual(
            pacer.tick(atNanoseconds: 16_666_666),
            .send(timestampNanoseconds: 16_666_666, nextDelayNanoseconds: 16_666_666)
        )
    }

    func testUpdatingFrameRateBeforeTheFirstTickReplacesTheStarterTick() {
        var pacer = ContinuousFramePacer(framesPerSecond: 30)
        pacer.setActive(true)
        XCTAssertEqual(pacer.latestFrameArrived(atNanoseconds: 0), .schedule(nanoseconds: 0))

        XCTAssertEqual(
            pacer.update(framesPerSecond: 120, atNanoseconds: 1),
            0
        )
        XCTAssertEqual(
            pacer.tick(atNanoseconds: 1),
            .send(timestampNanoseconds: 1, nextDelayNanoseconds: 8_333_333)
        )
    }

    func testDeactivationClearsRetainedCadenceState() {
        var pacer = ContinuousFramePacer(framesPerSecond: 30)
        pacer.setActive(true)
        XCTAssertEqual(pacer.latestFrameArrived(atNanoseconds: 0), .schedule(nanoseconds: 0))

        pacer.setActive(false)
        XCTAssertEqual(pacer.tick(atNanoseconds: 33_333_333), .stop)

        pacer.setActive(true)
        XCTAssertEqual(pacer.tick(atNanoseconds: 66_666_666), .stop)
        XCTAssertEqual(
            pacer.latestFrameArrived(atNanoseconds: 70_000_000),
            .schedule(nanoseconds: 0)
        )
    }
}
