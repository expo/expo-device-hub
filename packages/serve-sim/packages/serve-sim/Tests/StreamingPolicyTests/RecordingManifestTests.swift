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
    }
    func testRebootInterruptionsAreAdditiveAndPreserveAnUnresumedPause() throws {
        let manifest = RecordingManifest(
            firstFrame: Date(timeIntervalSince1970: 1_700_000_000), width: 120, height: 240,
            interruptions: [.init(pausedAtSeconds: 2, resumedAtSeconds: 20), .init(pausedAtSeconds: 30)]
        )
        let data = try JSONEncoder().encode(manifest)
        XCTAssertEqual(try JSONDecoder().decode(RecordingManifest.self, from: data), manifest)
        let object = try XCTUnwrap(JSONSerialization.jsonObject(with: data) as? [String: Any])
        let events = try XCTUnwrap(object["interruptions"] as? [[String: Any]])
        XCTAssertEqual(events[0]["reason"] as? String, "simulatorReboot")
        XCTAssertEqual(events[0]["resumedAtSeconds"] as? Double, 20)
        XCTAssertNil(events[1]["resumedAtSeconds"])
    }

}
