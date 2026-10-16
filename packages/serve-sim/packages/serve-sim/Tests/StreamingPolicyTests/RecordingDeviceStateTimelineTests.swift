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
        XCTAssertLessThanOrEqual(maximumEntriesPerSecond(entries), 4)
        XCTAssertEqual(entries.first, .init(timeMs: 0, state: state(angle: 0)))
        XCTAssertEqual(entries.last, .init(timeMs: Double(119) * 1_000 / 60, state: state(angle: 119)))
        for (previous, next) in zip(entries, entries.dropFirst()) {
            XCTAssertGreaterThanOrEqual(next.timeMs - previous.timeMs, 250)
        }
    }

    func testPoseOnlyChangesStayCappedWhenGeometryIsConstant() {
        var timeline = RecordingDeviceStateTimeline()
        let orientations = ["portrait", "facedown", "faceup"]
        for tick in 0..<120 {
            timeline.append(state: RecordingDeviceState(
                width: 120, height: 240, orientation: "portrait", screen: .inner, hingeAngle: Double(tick % 2),
                physicalOrientation: orientations[tick % 3], tableMode: tick % 4 == 0
            ), timeMs: Double(tick) * 1_000 / 60)
        }
        timeline.finish()
        XCTAssertLessThanOrEqual(maximumEntriesPerSecond(timeline.entries), 4)
    }

    func testGeometryChangesAreSavedAtTheirOwnFrameTime() {
        var timeline = RecordingDeviceStateTimeline()
        let rotated = RecordingDeviceState(
            width: 240, height: 120, orientation: "landscape_left", screen: .inner,
            hingeAngle: 0, physicalOrientation: "portrait", tableMode: false
        )
        var letterboxed = rotated
        letterboxed.contentRect = RecordingContentRect(x: 0, y: 10, width: 240, height: 100)
        let posed = RecordingDeviceState(
            width: 240, height: 120, orientation: "landscape_left", screen: .inner, hingeAngle: 90,
            physicalOrientation: "portrait", tableMode: false, contentRect: letterboxed.contentRect
        )
        timeline.append(state: state(angle: 0), timeMs: 0)
        timeline.append(state: rotated, timeMs: 100)
        timeline.append(state: letterboxed, timeMs: 150)
        timeline.append(state: posed, timeMs: 200)
        XCTAssertEqual(timeline.entries, [
            .init(timeMs: 0, state: state(angle: 0)),
            .init(timeMs: 100, state: rotated),
            .init(timeMs: 150, state: letterboxed),
        ])
    }

    func testEveryGeometryFieldKeepsItsFirstWrittenFrameTime() {
        let initial = state(angle: 90)
        for changed in [
            state(angle: 90, width: 121), state(angle: 90, height: 241),
            state(angle: 90, orientation: "landscape_left"), state(angle: 90, orientation: nil),
            state(angle: 90, screen: .outer), state(angle: 90, screen: nil),
            state(angle: 90, contentRect: .init(x: 1, y: 0, width: 119, height: 240)),
        ] {
            var timeline = RecordingDeviceStateTimeline()
            timeline.append(state: initial, timeMs: 0)
            timeline.append(state: changed, timeMs: 100)
            timeline.append(state: changed, timeMs: 200)
            timeline.finish()
            XCTAssertEqual(timeline.entries, [.init(timeMs: 0, state: initial), .init(timeMs: 100, state: changed)])
        }
    }

    func testFinishKeepsAGeometryEntryAndAppendsTheFinalPose() {
        var timeline = RecordingDeviceStateTimeline()
        let outer = RecordingDeviceState(width: 120, height: 240, orientation: "portrait", screen: .outer,
                                         hingeAngle: 0, physicalOrientation: "portrait", tableMode: false)
        let folded = RecordingDeviceState(width: 120, height: 240, orientation: "portrait", screen: .outer,
                                          hingeAngle: 5, physicalOrientation: "portrait", tableMode: false)
        timeline.append(state: state(angle: 0), timeMs: 0)
        timeline.append(state: outer, timeMs: 300)
        timeline.append(state: folded, timeMs: 350)
        timeline.finish()
        XCTAssertEqual(timeline.entries, [
            .init(timeMs: 0, state: state(angle: 0)),
            .init(timeMs: 300, state: outer),
            .init(timeMs: 350, state: folded),
        ])
    }

    func testFinishCoalescesTheLastPoseWithoutMovingLaterGeometry() {
        var timeline = RecordingDeviceStateTimeline()
        for (index, time) in [0, 250, 500, 750, 1_000].enumerated() {
            timeline.append(state: state(angle: Double(index)), timeMs: Double(time))
        }
        let outer = RecordingDeviceState(width: 120, height: 240, orientation: "portrait", screen: .outer,
                                         hingeAngle: 4, physicalOrientation: "portrait", tableMode: false)
        var shifted = outer
        shifted.contentRect = .init(x: 1, y: 0, width: 119, height: 240)
        let final = RecordingDeviceState(width: 120, height: 240, orientation: "portrait", screen: .outer,
                                         hingeAngle: 5, physicalOrientation: "portrait", tableMode: false,
                                         contentRect: shifted.contentRect)
        timeline.append(state: outer, timeMs: 1_050)
        timeline.append(state: shifted, timeMs: 1_075)
        timeline.append(state: final, timeMs: 1_100)
        timeline.finish()

        XCTAssertEqual(timeline.entries, [
            .init(timeMs: 0, state: state(angle: 0)),
            .init(timeMs: 250, state: state(angle: 1)),
            .init(timeMs: 500, state: state(angle: 2)),
            .init(timeMs: 750, state: state(angle: 3)),
            .init(timeMs: 1_050, state: outer),
            .init(timeMs: 1_075, state: shifted),
            .init(timeMs: 1_100, state: final),
        ])
        let poseEntries = timeline.entries.filter { $0.timeMs != 1_050 && $0.timeMs != 1_075 }
        XCTAssertLessThanOrEqual(maximumEntriesPerSecond(poseEntries), 4)
        timeline.finish()
        XCTAssertEqual(timeline.entries.count, 7)
    }

    func testFinishKeepsOlderPoseHistoryAcrossGeometryChanges() {
        var timeline = RecordingDeviceStateTimeline()
        let outer = RecordingDeviceState(width: 120, height: 240, orientation: "portrait", screen: .outer,
                                         hingeAngle: 90, physicalOrientation: "portrait", tableMode: false)
        let final = RecordingDeviceState(width: 120, height: 240, orientation: "portrait", screen: .outer,
                                         hingeAngle: 100, physicalOrientation: "portrait", tableMode: false)
        timeline.append(state: state(angle: 0), timeMs: 0)
        timeline.append(state: state(angle: 90), timeMs: 250)
        timeline.append(state: outer, timeMs: 1_000)
        timeline.append(state: final, timeMs: 1_050)
        timeline.finish()
        XCTAssertEqual(timeline.entries.map(\.timeMs), [0, 250, 1_000, 1_050])
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
            width: 240, height: 120, orientation: "landscape_left", screen: .outer,
            hingeAngle: 90, physicalOrientation: "facedown", tableMode: true
        )
        let unknownPose = RecordingDeviceState(
            width: 240, height: 120, orientation: "landscape_left", screen: .outer, hingeAngle: 90
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

    func testFinishPreservesLongHeldRotationWhenTheFinalFrameReturnsToPortrait() {
        var timeline = RecordingDeviceStateTimeline()
        let portrait = state(angle: 90)
        let landscape = RecordingDeviceState(
            width: 240, height: 120, orientation: "landscape_left", screen: .inner, hingeAngle: 90
        )
        timeline.append(state: portrait, timeMs: 0)
        timeline.append(state: landscape, timeMs: 250)
        timeline.append(state: landscape, timeMs: 9_750)
        timeline.append(state: portrait, timeMs: 10_000)
        timeline.finish()
        XCTAssertEqual(timeline.entries, [
            .init(timeMs: 0, state: portrait),
            .init(timeMs: 250, state: landscape),
            .init(timeMs: 10_000, state: portrait),
        ])
    }

    func testFinishOnEmptyTimelineHasNoEntries() {
        var timeline = RecordingDeviceStateTimeline()
        timeline.finish()
        XCTAssertTrue(timeline.entries.isEmpty)
    }

    private func maximumEntriesPerSecond(_ entries: [RecordingManifest.DeviceState]) -> Int {
        entries.map { start in
            entries.filter { $0.timeMs >= start.timeMs && $0.timeMs < start.timeMs + 1_000 }.count
        }.max() ?? 0
    }

    private func state(angle: Double, width: Int = 120, height: Int = 240, orientation: String? = "portrait",
                       screen: RecordingScreen? = .inner, contentRect: RecordingContentRect? = nil) -> RecordingDeviceState {
        RecordingDeviceState(width: width, height: height, orientation: orientation, screen: screen,
                             hingeAngle: angle, physicalOrientation: "portrait", tableMode: false, contentRect: contentRect)
    }
}
