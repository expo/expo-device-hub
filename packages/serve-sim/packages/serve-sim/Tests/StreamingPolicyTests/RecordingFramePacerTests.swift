import XCTest
@testable import StreamingPolicy

final class RecordingFramePacerTests: XCTestCase {
    func testOneIntervalDelayKeepsLogicalSlotZeroAndDoesNotRunEarly() {
        var pacer = RecordingFramePacer(startNanoseconds: 100)
        XCTAssertNil(pacer.tick(atNanoseconds: 100))
        XCTAssertNil(pacer.tick(atNanoseconds: 100 + RecordingFramePacer.intervalNanoseconds - 1))
        XCTAssertEqual(pacer.tick(atNanoseconds: 100 + RecordingFramePacer.intervalNanoseconds)?.index, 0)
        XCTAssertNil(pacer.tick(atNanoseconds: 100 + RecordingFramePacer.intervalNanoseconds))
    }

    func testStallAdvancesPTSWithGapsInsteadOfProducingCatchupSlots() {
        var pacer = RecordingFramePacer(startNanoseconds: 0)
        XCTAssertEqual(pacer.tick(atNanoseconds: RecordingFramePacer.intervalNanoseconds)?.index, 0)
        let resumed = pacer.tick(atNanoseconds: RecordingFramePacer.intervalNanoseconds * 12)
        XCTAssertEqual(resumed?.index, 11)
        XCTAssertEqual(resumed?.missed, 10)
        XCTAssertNil(pacer.tick(atNanoseconds: RecordingFramePacer.intervalNanoseconds * 12 + 1))
    }

    func testFinishSubmitsOnlyCurrentUndelayedSlotAndDoesNotDuplicateIt() {
        var pacer = RecordingFramePacer(startNanoseconds: 0)
        XCTAssertEqual(pacer.tick(atNanoseconds: RecordingFramePacer.intervalNanoseconds)?.index, 0)
        let last = pacer.finish(atNanoseconds: RecordingFramePacer.intervalNanoseconds * 12)
        XCTAssertEqual(last?.index, 12)
        XCTAssertEqual(last?.missed, 11)
        XCTAssertNil(pacer.finish(atNanoseconds: RecordingFramePacer.intervalNanoseconds * 12))
    }

    func testShortRecordingCanFinishItsFirstSlotWithoutWaiting() {
        var pacer = RecordingFramePacer(startNanoseconds: 100)
        XCTAssertEqual(pacer.finish(atNanoseconds: 101)?.index, 0)
        XCTAssertNil(pacer.finish(atNanoseconds: 99))
    }
}
