import XCTest
@testable import SimNative

final class DisplayDeviceStateTests: XCTestCase {
    func testPhysicalPoseDoesNotFollowTheAppsPortraitDisplay() throws {
        let data = try JSONSerialization.data(withJSONObject: [
            "orientation": ["currentDeviceOrientation": "landscapeLeft"],
            "displays": [["displayId": 1, "currentOrientation": "rot0"]]
        ])
        let snapshot = try JSONDecoder().decode(DisplayDeviceState.self, from: data)
        XCTAssertEqual(snapshot.physicalOrientation, "landscape-left")
    }

    func testMissingAndUnknownPhysicalPoseClearPreviousObservation() throws {
        let objects: [[String: Any]] = [[:], ["orientation": NSNull()],
                                       ["orientation": ["currentDeviceOrientation": "unknown"]]]
        for object in objects {
            let snapshot = try JSONDecoder().decode(DisplayDeviceState.self,
                from: JSONSerialization.data(withJSONObject: object))
            XCTAssertNil(snapshot.physicalOrientation)
            var observed = ObservedDeviceState(generation: 1)
            _ = observed.apply(.orientation(.init(orientation: "portrait", timestamp: 1)), since: 0)
            _ = observed.apply(.orientation(.init(orientation: snapshot.physicalOrientation, timestamp: 2)), since: 0)
            XCTAssertNil(observed.state.orientation)
            XCTAssertTrue(observed.snapshot.orientationObserved)
        }
    }
}
