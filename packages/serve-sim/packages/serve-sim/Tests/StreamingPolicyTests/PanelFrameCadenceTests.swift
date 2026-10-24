import XCTest
@testable import StreamingPolicy

final class PanelFrameCadenceTests: XCTestCase {
    func testMotionlessActivePanelKeepsNormalCadence() {
        var cadence = PanelFrameCadence()
        cadence.setActive(true)
        for frame in 0..<180 {
            XCTAssertTrue(cadence.shouldSend(atNanoseconds: UInt64(frame) * 16_666_667))
        }
        XCTAssertEqual(cadence.skippedRepeats, 0)
    }

    func testOnlyKnownInactivePanelUsesFiveKeepalivesPerSecond() {
        var cadence = PanelFrameCadence()
        cadence.setActive(false)
        let sends = (0..<60).filter { cadence.shouldSend(atNanoseconds: UInt64($0) * 16_666_667) }
        XCTAssertEqual(sends.count, 5)
        XCTAssertEqual(cadence.skippedRepeats, 55)
    }

    func testUnknownActivityNeverSuppressesTheScreen() {
        var cadence = PanelFrameCadence()
        cadence.setActive(false)
        XCTAssertTrue(cadence.shouldSend(atNanoseconds: 0))
        XCTAssertFalse(cadence.shouldSend(atNanoseconds: 16_666_667))
        cadence.setActive(nil)
        XCTAssertTrue(cadence.shouldSend(atNanoseconds: 33_333_334))
    }

    func testActivationAndExplicitRefreshBypassInactiveDeadline() {
        var cadence = PanelFrameCadence()
        cadence.setActive(false)
        XCTAssertTrue(cadence.shouldSend(atNanoseconds: 0))
        XCTAssertFalse(cadence.shouldSend(atNanoseconds: 16_666_667))
        cadence.requestFrame()
        XCTAssertTrue(cadence.shouldSend(atNanoseconds: 33_333_334))
        XCTAssertFalse(cadence.shouldSend(atNanoseconds: 50_000_001))
        cadence.setActive(true)
        XCTAssertTrue(cadence.shouldSend(atNanoseconds: 66_666_668))
        XCTAssertTrue(cadence.shouldSend(atNanoseconds: 83_333_335))
    }
}
