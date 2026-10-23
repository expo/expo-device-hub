import XCTest
@testable import SimNative

final class ObservedDeviceStateTests: XCTestCase {
    func testHistoricalInitialSamplesRemainUnknownUntilFreshNativeStateArrives() throws {
        var observed = ObservedDeviceState(generation: 2)
        XCTAssertFalse(observed.apply(.angle(.init(angle: 90, timestamp: 99)), since: 100))
        XCTAssertFalse(observed.apply(.motion(try motion(99, orientation: 6, tabletop: 7)), since: 100))
        XCTAssertEqual(observed.state, .init())
        XCTAssertTrue(observed.apply(.angle(.init(angle: 80, timestamp: 101)), since: 100))
        XCTAssertTrue(observed.apply(.motion(try motion(102, orientation: 3, tabletop: 5)), since: 100))
        XCTAssertEqual(observed.state, .init(angle: 80, orientation: "landscape-left", tableMode: true))
    }

    func testMotionAndAngleUseIndependentWatermarksAndAngleDoesNotEraseObservedPose() throws {
        var observed = ObservedDeviceState(generation: 1)
        XCTAssertTrue(observed.apply(.angle(.init(angle: 90, timestamp: 120)), since: 100))
        XCTAssertTrue(observed.apply(.motion(try motion(110, orientation: 6, tabletop: 7)), since: 100))
        XCTAssertTrue(observed.apply(.angle(.init(angle: 45, timestamp: 121)), since: 100))
        XCTAssertEqual(observed.state, .init(angle: 45, orientation: "facedown", tableMode: true))
        XCTAssertFalse(observed.apply(.motion(try motion(109, orientation: 1, tabletop: 0)), since: 100))
    }

    func testFreshInvalidFieldsClearPreviouslyKnownState() throws {
        var observed = ObservedDeviceState(generation: 1)
        observed.apply(.angle(.init(angle: 90, timestamp: 101)), since: 100)
        observed.apply(.motion(try motion(102, orientation: 1, tabletop: 3)), since: 100)
        observed.apply(.angle(.init(angle: 90, timestamp: 103, isAngleValid: false)), since: 100)
        XCTAssertEqual(observed.state, .init(orientation: "portrait", tableMode: true))
        let malformed = "{\"timestamp\":104,\"properties\":{\"propertyA\":{\"int\":\"portrait\"},\"propertyC\":{\"bool\":false}}}"
        observed.apply(.motion(try JSONDecoder().decode(DeviceMotionSample.self, from: Data(malformed.utf8))), since: 100)
        XCTAssertEqual(observed.state, .init())
    }

    func testNativeTabletopCodesAndPhysicalOrientationAreValidatedIndependently() throws {
        var observed = ObservedDeviceState(generation: 1)
        for code in 0...10 {
            observed.apply(.motion(try motion(Double(code + 101), orientation: 0, tabletop: code)), since: 100)
            XCTAssertEqual(observed.state.tableMode, code != 0)
            XCTAssertNil(observed.state.orientation)
        }
        for (index, code) in [-1, 11].enumerated() {
            observed.apply(.motion(try motion(Double(index + 112), orientation: 6, tabletop: code)), since: 100)
            XCTAssertEqual(observed.state.orientation, "facedown")
            XCTAssertNil(observed.state.tableMode)
        }
        for (index, name) in ["portrait", "pud", "landscape-left", "landscape-right", "faceup", "facedown"].enumerated() {
            XCTAssertEqual(ObservedPhysicalOrientation.name(index + 1), name)
        }
    }

    func testOrientationBootstrapCannotOverwriteANewerStreamEventOrInventTableState() throws {
        var observed = ObservedDeviceState(generation: 1)
        observed.apply(.orientation(.init(orientation: "facedown", timestamp: 101)), since: 100)
        XCTAssertEqual(observed.state, .init(orientation: "facedown"))
        observed.apply(.motion(try motion(103, orientation: 3, tabletop: 5)), since: 100)
        XCTAssertFalse(observed.apply(.orientation(.init(orientation: "portrait", timestamp: 102)), since: 100))
        XCTAssertEqual(observed.state, .init(orientation: "landscape-left", tableMode: true))
    }

    func testOlderBufferedMotionCanEstablishTableStateWithoutUndoingTheFreshGetter() throws {
        var observed = ObservedDeviceState(generation: 1)
        observed.apply(.orientation(.init(orientation: "facedown", timestamp: 103)), since: 100)
        observed.apply(.motion(try motion(102, orientation: 1, tabletop: 3)), since: 100)
        XCTAssertEqual(observed.state, .init(orientation: "facedown", tableMode: true))
    }

    func testFullSnapshotOmitsUnknownFieldsAndUsesNativeCallbackKeys() throws {
        var observed = ObservedDeviceState(generation: 3)
        observed.apply(.angle(.init(angle: 90, timestamp: 101)), since: 100)
        let data = try JSONEncoder().encode(observed.snapshot)
        let json = try XCTUnwrap(JSONSerialization.jsonObject(with: data) as? [String: Any])
        let state = try XCTUnwrap(json["state"] as? [String: Any])
        XCTAssertEqual(state["hingeAngle"] as? Double, 90)
        XCTAssertNil(state["physicalOrientation"])
        XCTAssertNil(state["tableMode"])
        XCTAssertEqual(json["generation"] as? Int, 3)
        XCTAssertEqual(json["revision"] as? Int, 1)
    }

    func testTentTableControlOverridesOnlyOlderMotionAndNeverChangesRawObservation() throws {
        var observed = ObservedDeviceState(generation: 1)
        observed.apply(.motion(try motion(11, orientation: 1, tabletop: 0)), since: 10)
        var controls = HingeControlEligibility()
        controls.angle = (80, 20)
        controls.orientation = ("facedown", 20)
        controls.tableMode = (true, 20)
        XCTAssertEqual(controls.state(observed: observed), .init(angle: 80, orientation: "facedown", tableMode: true))
        XCTAssertEqual(observed.state, .init(orientation: "portrait", tableMode: false))
        observed.apply(.motion(try motion(19, orientation: 1, tabletop: 0)), since: 10)
        XCTAssertEqual(controls.state(observed: observed).tableMode, true)
        observed.apply(.motion(try motion(21, orientation: 6, tabletop: 0)), since: 10)
        XCTAssertEqual(controls.state(observed: observed).tableMode, false)
        observed.apply(.motion(try motion(22, orientation: 6, tabletop: 99)), since: 10)
        XCTAssertNil(controls.state(observed: observed).tableMode)
    }

    private func motion(_ timestamp: Double, orientation: Int, tabletop: Int) throws -> DeviceMotionSample {
        let json = "{\"timestamp\":\(timestamp),\"properties\":{\"propertyA\":{\"int\":\(orientation)},\"propertyC\":{\"int\":\(tabletop)}}}"
        return try JSONDecoder().decode(DeviceMotionSample.self, from: Data(json.utf8))
    }
}
