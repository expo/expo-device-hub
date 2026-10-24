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

    func testRebootInterruptionsAreAdditiveAndPreserveAnUnresumedPause() throws {
        let manifest = RecordingManifest(
            firstFrame: Date(timeIntervalSince1970: 1_700_000_000), width: 120, height: 240,
            interruptions: [.init(pausedAtSeconds: 2, resumedAtSeconds: 20), .init(pausedAtSeconds: 30)],
            deviceStates: [.init(timeMs: 0, state: RecordingDeviceState(width: 120, height: 240))]
        )
        let data = try JSONEncoder().encode(manifest)
        XCTAssertEqual(try JSONDecoder().decode(RecordingManifest.self, from: data), manifest)
        let object = try XCTUnwrap(JSONSerialization.jsonObject(with: data) as? [String: Any])
        let events = try XCTUnwrap(object["interruptions"] as? [[String: Any]])
        XCTAssertEqual(events[0]["reason"] as? String, "simulatorReboot")
        XCTAssertEqual(events[0]["resumedAtSeconds"] as? Double, 20)
        XCTAssertNil(events[1]["resumedAtSeconds"])
        XCTAssertEqual((object["deviceStates"] as? [[String: Any]])?.count, 1)
    }

    func testDeviceStatesDescribeRecordedScreenAndDuoPose() throws {
        let state = RecordingDeviceState(
            width: 2_080, height: 2_622, orientation: "landscape_left", screen: .outer,
            hingeAngle: 80, physicalOrientation: "facedown", tableMode: true
        )
        let unknownPose = RecordingDeviceState(
            width: 1_206, height: 2_622, orientation: "portrait", screen: .inner, hingeAngle: 45.5
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
        XCTAssertEqual(recorded["screen"] as? String, "outer")
        XCTAssertNil(recorded["screenId"])
        XCTAssertEqual(recorded["hingeAngle"] as? Double, 80)
        XCTAssertEqual(recorded["physicalOrientation"] as? String, "facedown")
        XCTAssertEqual(recorded["tableMode"] as? Bool, true)
        let next = try XCTUnwrap(entries[1]["state"] as? [String: Any])
        XCTAssertEqual(next["width"] as? Int, 1_206)
        XCTAssertEqual(next["screen"] as? String, "inner")
        XCTAssertNil(next["screenId"])
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
    func testSemanticScreenRoundTripsWithoutNumericRoutingIdentity() throws {
        for screen in ["inner", "outer"] {
            let data = Data("{\"width\":120,\"height\":240,\"screen\":\"\(screen)\"}".utf8)
            let state = try JSONDecoder().decode(RecordingDeviceState.self, from: data)
            let object = try XCTUnwrap(JSONSerialization.jsonObject(
                with: JSONEncoder().encode(state)
            ) as? [String: Any])
            XCTAssertEqual(object["screen"] as? String, screen)
            XCTAssertNil(object["screenId"])
        }
    }

    func testLegacyNumericScreenIdIsIgnoredWhenRewritingManifest() throws {
        let data = Data("""
        {
          "firstFrameWallClock": {"unixMs":1700000000125,"iso8601":"2023-11-14T22:13:20.125Z"},
          "width":2008,"height":2854,"recording":"recording.mp4",
          "deviceStates":[{"timeMs":0,"state":{"width":2007,"height":2853,"screenId":3,"hingeAngle":90}}]
        }
        """.utf8)
        let manifest = try JSONDecoder().decode(RecordingManifest.self, from: data)
        let state = try XCTUnwrap(manifest.deviceStates?.first?.state)
        XCTAssertNil(state.contentRect)
        let object = try XCTUnwrap(JSONSerialization.jsonObject(
            with: JSONEncoder().encode(state)
        ) as? [String: Any])
        XCTAssertEqual(object["width"] as? Int, 2007)
        XCTAssertEqual(object["hingeAngle"] as? Double, 90)
        XCTAssertNil(object["screen"])
        XCTAssertNil(object["screenId"])
    }
    func testContentRectRoundTripsWithTopLeftPixelCoordinates() throws {
        let state = RecordingDeviceState(width: 1398, height: 2034, screen: .outer,
            contentRect: .init(x: 24, y: 0, width: 1960, height: 2854))
        let data = try JSONEncoder().encode(state)
        let object = try XCTUnwrap(JSONSerialization.jsonObject(with: data) as? [String: Any])
        XCTAssertEqual(object["contentRect"] as? [String: Int], ["x": 24, "y": 0, "width": 1960, "height": 2854])
        XCTAssertEqual(try JSONDecoder().decode(RecordingDeviceState.self, from: data), state)
    }

}
