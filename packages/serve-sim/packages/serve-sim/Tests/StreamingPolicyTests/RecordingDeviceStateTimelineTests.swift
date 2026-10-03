import XCTest
@testable import StreamingPolicy

final class RecordingDeviceStateTimelineTests: XCTestCase {
    func testRapidChangesKeepAtMostFourEntriesInAnySecondAndPreserveFinalState() throws {
        var timeline = RecordingDeviceStateTimeline()
        for tick in 0..<120 {
            timeline.append(state: state(angle: Double(tick)), timeMs: Double(tick) * 1_000 / 60)
        }
        timeline.finish()

        let entries = timeline.entries
        let maximum = entries.map { start in
            entries.filter { $0.timeMs >= start.timeMs && $0.timeMs < start.timeMs + 1_000 }.count
        }.max() ?? 0
        XCTAssertLessThanOrEqual(maximum, 4)
        XCTAssertEqual(entries.first, .init(timeMs: 0, state: state(angle: 0)))
        XCTAssertEqual(entries.last, .init(timeMs: Double(119) * 1_000 / 60, state: state(angle: 119)))
        for (previous, next) in zip(entries, entries.dropFirst()) {
            XCTAssertGreaterThanOrEqual(next.timeMs - previous.timeMs, 250)
        }
    }

    func testBoundaryUsesLatestStateAndRepeatedFramesFlushIt() {
        var timeline = RecordingDeviceStateTimeline()
        timeline.append(state: state(angle: 0), timeMs: 0)
        timeline.append(state: state(angle: 30), timeMs: 50)
        timeline.append(state: state(angle: 60), timeMs: 100)
        timeline.append(state: state(angle: 90), timeMs: 249)
        XCTAssertEqual(timeline.entries, [.init(timeMs: 0, state: state(angle: 0))])

        timeline.append(state: state(angle: 120), timeMs: 250)
        timeline.append(state: state(angle: 150), timeMs: 400)
        timeline.append(state: state(angle: 150), timeMs: 500)
        XCTAssertEqual(timeline.entries, [
            .init(timeMs: 0, state: state(angle: 0)),
            .init(timeMs: 250, state: state(angle: 120)),
            .init(timeMs: 500, state: state(angle: 150)),
        ])
    }

    func testReturningToPreviousStateDiscardsTransientChanges() {
        var timeline = RecordingDeviceStateTimeline()
        timeline.append(state: state(angle: 0), timeMs: 0)
        timeline.append(state: state(angle: 90), timeMs: 100)
        timeline.append(state: state(angle: 0), timeMs: 249)
        timeline.append(state: state(angle: 0), timeMs: 250)
        timeline.finish()
        XCTAssertEqual(timeline.entries, [.init(timeMs: 0, state: state(angle: 0))])
    }

    func testScreenAndUnknownPoseChangesRemainDistinctAtTheSameHingeAngle() {
        var timeline = RecordingDeviceStateTimeline()
        let initial = state(angle: 90)
        let landscape = RecordingDeviceState(
            width: 240, height: 120, orientation: "landscape_left", screenId: 1,
            hingeAngle: 90, physicalOrientation: "facedown", tableMode: true
        )
        let unknownPose = RecordingDeviceState(
            width: 240, height: 120, orientation: "landscape_left", screenId: 1, hingeAngle: 90
        )
        timeline.append(state: initial, timeMs: 0)
        timeline.append(state: landscape, timeMs: 250)
        timeline.append(state: unknownPose, timeMs: 500)
        timeline.finish()
        XCTAssertEqual(timeline.entries, [
            .init(timeMs: 0, state: initial),
            .init(timeMs: 250, state: landscape),
            .init(timeMs: 500, state: unknownPose),
        ])
    }

    func testFinishCoalescesLatestStateAtItsActualFrameTime() {
        var timeline = RecordingDeviceStateTimeline()
        timeline.append(state: state(angle: 0), timeMs: 0)
        timeline.append(state: state(angle: 90), timeMs: 250)
        timeline.append(state: state(angle: 180), timeMs: 300)
        timeline.append(state: state(angle: 180), timeMs: 400)
        timeline.finish()
        XCTAssertEqual(timeline.entries, [
            .init(timeMs: 0, state: state(angle: 0)),
            .init(timeMs: 400, state: state(angle: 180)),
        ])
    }

    func testFinishCollapsesAdjacentEqualStatesAfterCoalescing() {
        var timeline = RecordingDeviceStateTimeline()
        timeline.append(state: state(angle: 0), timeMs: 0)
        timeline.append(state: state(angle: 90), timeMs: 250)
        timeline.append(state: state(angle: 0), timeMs: 300)
        timeline.append(state: state(angle: 0), timeMs: 400)
        timeline.finish()
        XCTAssertEqual(timeline.entries, [.init(timeMs: 0, state: state(angle: 0))])
    }

    func testShortRecordingKeepsTrueInitialAndFinalStates() {
        var timeline = RecordingDeviceStateTimeline()
        timeline.append(state: state(angle: 0), timeMs: 0)
        timeline.append(state: state(angle: 90), timeMs: 100)
        timeline.append(state: state(angle: 180), timeMs: 200)
        timeline.finish()
        XCTAssertEqual(timeline.entries, [
            .init(timeMs: 0, state: state(angle: 0)),
            .init(timeMs: 200, state: state(angle: 180)),
        ])
        timeline.finish()
        XCTAssertEqual(timeline.entries.count, 2)
    }

    func testFinishOnEmptyTimelineHasNoEntries() {
        var timeline = RecordingDeviceStateTimeline()
        timeline.finish()
        XCTAssertTrue(timeline.entries.isEmpty)
    }

    private func state(angle: Double) -> RecordingDeviceState {
        RecordingDeviceState(width: 120, height: 240, orientation: "portrait", screenId: 0,
                             hingeAngle: angle, physicalOrientation: "portrait", tableMode: false)
    }
}
