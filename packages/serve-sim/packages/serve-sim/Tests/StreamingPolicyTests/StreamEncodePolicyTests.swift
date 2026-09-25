import XCTest
@testable import StreamingPolicy

/// A 1206x2622 iPhone 17 surface. Level 3.1 allows a 1392 long edge; Level 5.2 fits it whole.
private let nativeWidth = 1206
private let nativeHeight = 2622
private let level31LongEdge = 1392

final class StreamEncodePolicyTests: XCTestCase {
    private func cap(
        configured: Int = 0,
        codec: String = "H264",
        level: Int = H264LevelPolicy.defaultLevelIdc,
        width: Int = nativeWidth,
        height: Int = nativeHeight
    ) -> Int {
        StreamEncodePolicy.encodeMaxLongEdge(
            configuredMaxDimension: configured,
            codecName: codec,
            sourceWidth: width,
            sourceHeight: height,
            levelIdc: level
        )
    }

    func testCapsH264ToWhatTheNegotiatedLevelAllows() {
        XCTAssertEqual(cap(level: 31), level31LongEdge)
    }

    func testDoesNotScaleAPeerWhoseLevelCoversTheWholeSurface() {
        XCTAssertEqual(cap(level: 52), 0)
    }

    func testDefaultLevelIsWhatBrowsersAdvertise() {
        XCTAssertEqual(H264LevelPolicy.defaultLevelIdc, 31)
        XCTAssertEqual(cap(), level31LongEdge)
    }

    func testLeavesOtherCodecsAlone() {
        XCTAssertEqual(cap(codec: "VP8", level: 31), 0)
        XCTAssertEqual(cap(codec: "VP9", level: 31), 0)
        XCTAssertEqual(cap(configured: 2622, codec: "VP8", level: 31), 2622)
    }

    func testExplicitMaxDimensionChoosesTheSizeWhenItFitsTheLevel() {
        XCTAssertEqual(cap(configured: 720, codec: "h264", level: 31), 720)
        XCTAssertEqual(cap(configured: 1280, level: 31), 1280)
        XCTAssertEqual(cap(configured: 1920, level: 52), 1920)
        XCTAssertEqual(cap(configured: 2622, level: 52), 2622)
    }

    /// Asking for more than the level allows yields no picture, not a bigger one.
    func testExplicitMaxDimensionIsClampedToTheLevel() {
        XCTAssertEqual(cap(configured: 1920, level: 31), level31LongEdge)
        XCTAssertEqual(cap(configured: 2622, level: 31), level31LongEdge)
    }

    func testNegativeMaxDimensionIsTreatedAsUnset() {
        XCTAssertEqual(cap(configured: -1, level: 31), level31LongEdge)
        XCTAssertEqual(cap(configured: -1, codec: "VP8", level: 31), 0)
    }

    /// `applySenderParameters` runs once before the first frame, when the source size is 0.
    func testUnknownSourceSizeDoesNotScale() {
        XCTAssertEqual(cap(level: 31, width: 0, height: 0), 0)
        XCTAssertEqual(cap(configured: 1920, level: 31, width: 0, height: 0), 1920)
    }

    func testCodecNameIsCaseInsensitive() {
        XCTAssertEqual(cap(codec: "h264", level: 31), level31LongEdge)
    }

    func testDoesNotScaleASurfaceThatAlreadyFits() {
        // 640x1136 is 2840 macroblocks, inside Level 3.1's 3600.
        XCTAssertEqual(cap(level: 31, width: 640, height: 1136), 0)
        // 750x1334 is 3948, outside it.
        XCTAssertEqual(cap(level: 31, width: 750, height: 1334), 1280)
    }
}
