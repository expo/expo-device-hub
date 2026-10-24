import XCTest
@testable import SimNative

final class HingeControlEligibilityTests: XCTestCase {
    func testDelayedAngleAndUnrelatedMotionCannotRevokeASuccessfulAngle() throws {
        var observed = ObservedDeviceState(generation: 1)
        observed.apply(.angle(.init(angle: 0, timestamp: 11)), since: 10)
        var controls = HingeControlEligibility()
        controls.angle = (90, 20)
        observed.apply(.angle(.init(angle: 40, timestamp: 19)), since: 10)
        observed.apply(.motion(try motion(21, orientation: 1, tabletop: 0)), since: 10)
        XCTAssertEqual(controls.state(observed: observed), .init(angle: 90, orientation: "portrait", tableMode: false))
        XCTAssertEqual(observed.state.angle, 40, "Admission must not replace sensor state")
    }

    func testASameValuedFreshAngleEndsTheOverrideWithoutANewRevision() {
        var observed = ObservedDeviceState(generation: 1)
        observed.apply(.angle(.init(angle: 0, timestamp: 11)), since: 10)
        let revision = observed.revision
        var controls = HingeControlEligibility()
        controls.angle = (90, 20)
        observed.apply(.angle(.init(angle: 0, timestamp: 21)), since: 10)
        XCTAssertEqual(observed.revision, revision)
        XCTAssertEqual(controls.state(observed: observed).angle, 0)
    }

    func testFreshUnknownAndExternalAngleSupersedeTheCommand() {
        var observed = ObservedDeviceState(generation: 1)
        var controls = HingeControlEligibility()
        controls.angle = (90, 20)
        observed.apply(.angle(.init(angle: 90, timestamp: 21, isAngleValid: false)), since: 10)
        XCTAssertNil(controls.state(observed: observed).angle)
        observed.apply(.angle(.init(angle: 180, timestamp: 22)), since: 10)
        XCTAssertEqual(controls.state(observed: observed).angle, 180)
    }

    func testOrientationHasItsOwnFenceAndCanBecomeUnknown() throws {
        var observed = ObservedDeviceState(generation: 1)
        observed.apply(.orientation(.init(orientation: "landscape-left", timestamp: 11)), since: 10)
        var controls = HingeControlEligibility()
        controls.orientation = ("portrait", 20)
        observed.apply(.orientation(.init(orientation: "facedown", timestamp: 19)), since: 10)
        observed.apply(.angle(.init(angle: 90, timestamp: 21)), since: 10)
        XCTAssertEqual(controls.state(observed: observed), .init(angle: 90, orientation: "portrait"))
        observed.apply(.motion(try motion(22, orientation: 0, tabletop: 0)), since: 10)
        XCTAssertNil(controls.state(observed: observed).orientation)
        XCTAssertEqual(controls.state(observed: observed).tableMode, false)
    }

    func testEachFieldUsesItsOwnLatestSuccessfulSend() {
        var observed = ObservedDeviceState(generation: 1)
        var controls = HingeControlEligibility()
        controls.angle = (45, 15)
        controls.angle = (90, 20)
        controls.orientation = ("portrait", 25)
        observed.apply(.angle(.init(angle: 0, timestamp: 21)), since: 10)
        observed.apply(.orientation(.init(orientation: "facedown", timestamp: 24)), since: 10)
        XCTAssertEqual(controls.state(observed: observed), .init(angle: 0, orientation: "portrait"))
        observed.apply(.orientation(.init(orientation: "faceup", timestamp: 26)), since: 10)
        XCTAssertEqual(controls.state(observed: observed).orientation, "faceup")
    }

    func testAnEqualTimestampDoesNotClaimToFollowTheCommand() {
        var observed = ObservedDeviceState(generation: 1)
        var controls = HingeControlEligibility()
        controls.angle = (90, 20)
        observed.apply(.angle(.init(angle: 0, timestamp: 20)), since: 10)
        XCTAssertEqual(controls.state(observed: observed).angle, 90)
    }

    func testOrientationReadSpanningSuccessfulSendRemainsUnknown() {
        for (sent, returned) in [("portrait", "faceup"), ("faceup", "portrait")] {
            var observed = ObservedDeviceState(generation: 1)
            var controls = HingeControlEligibility()
            controls.orientation = (sent, 11)
            let read = PhysicalOrientationSample(orientation: returned, timestamp: 10, readCompletedAt: 13)
            controls.recordOrientationRead(read, since: 10)
            observed.apply(.orientation(read), since: 10)
            XCTAssertNil(controls.state(observed: observed).orientation)
            XCTAssertEqual(observed.state.orientation, returned, "Admission must not replace sensor state")
        }
    }

    func testOrientationReadOverlapIncludesBothEndpoints() {
        for sentAt in [10.0, 11.0, 13.0] {
            var observed = ObservedDeviceState(generation: 1)
            var controls = HingeControlEligibility()
            controls.orientation = ("portrait", sentAt)
            let read = PhysicalOrientationSample(orientation: "faceup", timestamp: 10, readCompletedAt: 13)
            controls.recordOrientationRead(read, since: 10)
            observed.apply(.orientation(read), since: 10)
            XCTAssertNil(controls.state(observed: observed).orientation, "Overlapping send at \(sentAt)")
        }
    }

    func testCommandsOutsideTheReadIntervalKeepTheirSourceOrdering() {
        for (sentAt, expected) in [(9.0, "faceup"), (14.0, "portrait")] {
            var observed = ObservedDeviceState(generation: 1)
            var controls = HingeControlEligibility()
            controls.orientation = ("portrait", sentAt)
            let read = PhysicalOrientationSample(orientation: "faceup", timestamp: 10, readCompletedAt: 13)
            controls.recordOrientationRead(read, since: 10)
            observed.apply(.orientation(read), since: 10)
            XCTAssertEqual(controls.state(observed: observed).orientation, expected)
        }
    }

    func testBufferedMotionInsideTheReadIntervalCannotResolveAmbiguityInEitherOrder() throws {
        for motionFirst in [false, true] {
            var observed = ObservedDeviceState(generation: 1)
            var controls = HingeControlEligibility()
            controls.orientation = ("portrait", 11)
            let read = PhysicalOrientationSample(orientation: "faceup", timestamp: 10, readCompletedAt: 13)
            let buffered = DeviceStateUpdate.motion(try motion(11.5, orientation: 1, tabletop: 0))
            if motionFirst { observed.apply(buffered, since: 10) }
            controls.recordOrientationRead(read, since: 10)
            observed.apply(.orientation(read), since: 10)
            if !motionFirst { observed.apply(buffered, since: 10) }
            XCTAssertEqual(observed.state.orientation, "portrait")
            XCTAssertNil(controls.state(observed: observed).orientation)
            observed.apply(.motion(try motion(14, orientation: 5, tabletop: 0)), since: 10)
            XCTAssertEqual(controls.state(observed: observed).orientation, "faceup")
        }
    }

    func testAngleAndTableUpdatesCannotEndOrientationAmbiguityButANewerOrientationSendCan() throws {
        var observed = ObservedDeviceState(generation: 1)
        var controls = HingeControlEligibility()
        controls.orientation = ("portrait", 11)
        let read = PhysicalOrientationSample(orientation: "faceup", timestamp: 10, readCompletedAt: 13)
        controls.recordOrientationRead(read, since: 10)
        observed.apply(.orientation(read), since: 10)
        controls.angle = (45, 14)
        observed.apply(.angle(.init(angle: 90, timestamp: 15)), since: 10)
        observed.apply(.motion(try motion(12, orientation: 1, tabletop: 1)), since: 10)
        XCTAssertEqual(controls.state(observed: observed), .init(angle: 90, tableMode: true))
        controls.orientation = ("faceup", 14)
        XCTAssertEqual(controls.state(observed: observed).orientation, "faceup")
    }

    func testPointOrientationSamplesDoNotCreateReadAmbiguity() {
        var observed = ObservedDeviceState(generation: 1)
        var controls = HingeControlEligibility()
        controls.orientation = ("portrait", 11)
        let delayed = PhysicalOrientationSample(orientation: "faceup", timestamp: 10)
        controls.recordOrientationRead(delayed, since: 10)
        observed.apply(.orientation(delayed), since: 10)
        XCTAssertEqual(controls.state(observed: observed).orientation, "portrait")
        let fresh = PhysicalOrientationSample(orientation: "faceup", timestamp: 12)
        controls.recordOrientationRead(fresh, since: 10)
        observed.apply(.orientation(fresh), since: 10)
        XCTAssertEqual(controls.state(observed: observed).orientation, "faceup")
    }

    func testAReadFromBeforeTheObservationStartedCannotCreateAmbiguity() {
        var observed = ObservedDeviceState(generation: 1)
        var controls = HingeControlEligibility()
        controls.orientation = ("portrait", 11)
        let stale = PhysicalOrientationSample(orientation: "faceup", timestamp: 9, readCompletedAt: 13)
        controls.recordOrientationRead(stale, since: 10)
        XCTAssertFalse(observed.apply(.orientation(stale), since: 10))
        XCTAssertEqual(controls.state(observed: observed).orientation, "portrait")
    }

    private func motion(_ timestamp: Double, orientation: Int, tabletop: Int) throws -> DeviceMotionSample {
        let json = "{\"timestamp\":\(timestamp),\"properties\":{\"propertyA\":{\"int\":\(orientation)},\"propertyC\":{\"int\":\(tabletop)}}}"
        return try JSONDecoder().decode(DeviceMotionSample.self, from: Data(json.utf8))
    }
}
