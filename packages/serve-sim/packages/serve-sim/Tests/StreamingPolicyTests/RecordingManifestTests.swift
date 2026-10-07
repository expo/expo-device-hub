import Foundation
import XCTest
@testable import StreamingPolicy

final class RecordingManifestTests: XCTestCase {
    func testMatchesRecordSimUploadSchema() throws {
        let manifest = RecordingManifest(
            firstFrame: Date(timeIntervalSince1970: 1_700_000_000.125),
            width: 2_080, height: 2_622
        )
        let object = try XCTUnwrap(JSONSerialization.jsonObject(
            with: JSONEncoder().encode(manifest)
        ) as? [String: Any])
        let clock = try XCTUnwrap(object["firstFrameWallClock"] as? [String: Any])
        XCTAssertEqual(object["width"] as? Int, 2_080)
        XCTAssertEqual(object["height"] as? Int, 2_622)
        XCTAssertEqual(object["recording"] as? String, "recording.mp4")
        XCTAssertEqual(clock["unixMs"] as? Int64, 1_700_000_000_125)
        XCTAssertEqual(clock["iso8601"] as? String, "2023-11-14T22:13:20.125Z")
        XCTAssertNil(object["deviceStates"])
    }

    func testDeviceStatesDescribeRecordedScreenAndDuoPose() throws {
        let state = RecordingDeviceState(
            width: 2_080, height: 2_622, orientation: "landscape_left", screenId: 1,
            hingeAngle: 80, physicalOrientation: "facedown", tableMode: true
        )
        let unknownPose = RecordingDeviceState(
            width: 1_206, height: 2_622, orientation: "portrait", screenId: 0, hingeAngle: 45.5
        )
        let manifest = RecordingManifest(
            firstFrame: Date(timeIntervalSince1970: 1_700_000_000.125),
            width: 2_622, height: 2_622,
            deviceStates: [.init(timeMs: 0, state: state), .init(timeMs: 125.5, state: unknownPose)]
        )
        let data = try JSONEncoder().encode(manifest)
        let object = try XCTUnwrap(JSONSerialization.jsonObject(with: data) as? [String: Any])
        let entries = try XCTUnwrap(object["deviceStates"] as? [[String: Any]])
        XCTAssertEqual(entries.count, 2)
        XCTAssertEqual(entries[0]["timeMs"] as? Double, 0)
        XCTAssertEqual(entries[1]["timeMs"] as? Double, 125.5)
        let recorded = try XCTUnwrap(entries[0]["state"] as? [String: Any])
        XCTAssertEqual(recorded["width"] as? Int, 2_080)
        XCTAssertEqual(recorded["height"] as? Int, 2_622)
        XCTAssertEqual(recorded["orientation"] as? String, "landscape_left")
        XCTAssertEqual(recorded["screenId"] as? Int, 1)
        XCTAssertEqual(recorded["hingeAngle"] as? Double, 80)
        XCTAssertEqual(recorded["physicalOrientation"] as? String, "facedown")
        XCTAssertEqual(recorded["tableMode"] as? Bool, true)
        let next = try XCTUnwrap(entries[1]["state"] as? [String: Any])
        XCTAssertEqual(next["width"] as? Int, 1_206)
        XCTAssertEqual(next["screenId"] as? Int, 0)
        XCTAssertEqual(next["hingeAngle"] as? Double, 45.5)
        XCTAssertNil(next["physicalOrientation"])
        XCTAssertNil(next["tableMode"])
        XCTAssertEqual(try JSONDecoder().decode(RecordingManifest.self, from: data), manifest)
    }

    func testUnknownStateFieldsAreOmitted() throws {
        let state = RecordingDeviceState(width: 120, height: 240)
        let object = try XCTUnwrap(JSONSerialization.jsonObject(
            with: JSONEncoder().encode(state)
        ) as? [String: Any])
        XCTAssertEqual(Set(object.keys), ["width", "height"])
    }

    func testLegacyManifestDecodesWithoutDeviceStates() throws {
        let data = Data("""
        {
          "firstFrameWallClock": {"unixMs": 1700000000125, "iso8601": "2023-11-14T22:13:20.125Z"},
          "width": 2080,
          "height": 2622,
          "recording": "recording.mp4"
        }
        """.utf8)
        let manifest = try JSONDecoder().decode(RecordingManifest.self, from: data)
        XCTAssertNil(manifest.deviceStates)
        XCTAssertEqual(manifest.width, 2_080)
    }
}
