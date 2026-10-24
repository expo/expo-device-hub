import XCTest
@testable import SimNative

final class ActiveDisplayObservationTests: XCTestCase {
    func testOnlyFreshUnambiguousElectionCanSuppressAPanel() {
        let observations = ActiveDisplayObservation()
        let owner = NSObject()
        let identity = ObjectIdentifier(owner)
        XCTAssertNil(observations.isActive(udid: "device", screenID: 1, nowNs: 0))
        observations.record(udid: "device", owner: identity, screenID: 3, nowNs: 10)
        XCTAssertEqual(observations.isActive(udid: "device", screenID: 1, nowNs: 11), false)
        XCTAssertEqual(observations.isActive(udid: "device", screenID: 3, nowNs: 11), true)
        XCTAssertNil(observations.isActive(udid: "other", screenID: 1, nowNs: 11))
        XCTAssertNil(observations.isActive(udid: "device", screenID: 1, nowNs: 9))
        XCTAssertNil(observations.isActive(udid: "device", screenID: 1, nowNs: 1_000_000_011))
        observations.record(udid: "device", owner: identity, screenID: nil, nowNs: 20)
        XCTAssertNil(observations.isActive(udid: "device", screenID: 1, nowNs: 21))
    }

    func testStoppingAnOldCaptureCannotRemoveItsReplacementElection() {
        let observations = ActiveDisplayObservation()
        let old = NSObject(), replacement = NSObject()
        observations.record(udid: "device", owner: ObjectIdentifier(old), screenID: 1, nowNs: 0)
        observations.record(udid: "device", owner: ObjectIdentifier(replacement), screenID: 3, nowNs: 10)
        observations.remove(udid: "device", owner: ObjectIdentifier(old))
        XCTAssertEqual(observations.isActive(udid: "device", screenID: 1, nowNs: 11), false)
        observations.remove(udid: "device", owner: ObjectIdentifier(replacement))
        XCTAssertNil(observations.isActive(udid: "device", screenID: 1, nowNs: 12))
    }
}
