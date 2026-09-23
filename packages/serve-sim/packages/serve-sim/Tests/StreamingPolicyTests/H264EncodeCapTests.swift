import XCTest
@testable import StreamingPolicy

final class H264EncodeCapTests: XCTestCase {
    func testCapsH264WhenNoExplicitMaxDimension() {
        // Temporary guard: H.264 streams stall at larger encode sizes for reasons we have
        // not root-caused. Until then, do not hand H.264 a full-size Retina surface.
        XCTAssertEqual(
            StreamEncodePolicy.h264EncodeMaxLongEdge(configuredMaxDimension: 0, codecName: "H264"),
            1280
        )
    }

    func testLeavesOtherCodecsAlone() {
        XCTAssertEqual(
            StreamEncodePolicy.h264EncodeMaxLongEdge(configuredMaxDimension: 0, codecName: "VP8"),
            0
        )
        XCTAssertEqual(
            StreamEncodePolicy.h264EncodeMaxLongEdge(configuredMaxDimension: 0, codecName: "VP9"),
            0
        )
    }

    func testExplicitMaxDimensionAlwaysWins() {
        // An operator asking for a specific size gets it, capped or not.
        XCTAssertEqual(
            StreamEncodePolicy.h264EncodeMaxLongEdge(configuredMaxDimension: 1920, codecName: "H264"),
            1920
        )
        XCTAssertEqual(
            StreamEncodePolicy.h264EncodeMaxLongEdge(configuredMaxDimension: 720, codecName: "h264"),
            720
        )
    }

    func testCodecNameIsCaseInsensitive() {
        XCTAssertEqual(
            StreamEncodePolicy.h264EncodeMaxLongEdge(configuredMaxDimension: 0, codecName: "h264"),
            1280
        )
    }
}
