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
}
