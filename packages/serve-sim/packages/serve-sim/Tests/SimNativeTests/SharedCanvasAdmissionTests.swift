import XCTest
@testable import SimNative
import StreamingPolicy

final class SharedCanvasAdmissionTests: XCTestCase {
    func testHighLevelViewerKeepsNativeCanvas() {
        let source = Dimensions(width: 1206, height: 2622)
        let canvas = WebRTCPublisher.canvasSize(
            for: source, maxDimension: 0, levels: [52], scale: 1
        )

        XCTAssertEqual(canvas, source)
    }

    func testVp8OnlyViewerKeepsNativeCanvas() {
        let source = Dimensions(width: 1206, height: 2622)
        let canvas = WebRTCPublisher.canvasSize(
            for: source, maxDimension: 0, levels: [], scale: 0.5
        )

        XCTAssertEqual(canvas, source)
    }

    func testLowerLevelViewerUsesProposedCanvasBeforeAdmission() {
        let source = Dimensions(width: 1920, height: 1080)
        let current = WebRTCPublisher.canvasSize(
            for: source, maxDimension: 0, levels: [52], scale: 1
        )
        let proposed = WebRTCPublisher.canvasSize(
            for: source, maxDimension: 0, levels: [52, 22], scale: 1
        )

        XCTAssertGreaterThan(H264LevelPolicy.macroblocks(width: current.width, height: current.height),
                             H264LevelPolicy.maxFrameSize(levelIdc: 22))
        XCTAssertLessThanOrEqual(H264LevelPolicy.macroblocks(width: proposed.width, height: proposed.height),
                                 H264LevelPolicy.maxFrameSize(levelIdc: 22))
        XCTAssertLessThan(proposed.width, current.width)
    }

    func testLowerLevelH264OfferDoesNotFallBackBeforeCanvasCanShrink() {
        let offer = "a=rtpmap:96 VP8/90000\na=rtpmap:102 H264/90000\na=fmtp:102 profile-level-id=42e01f"
        XCTAssertFalse(WebRTCPublisher.shouldPreferVP8(
            offer: offer, rawCanvas: Dimensions(width: 1206, height: 2622),
            maxDimension: 0, levels: [], scale: 1
        ))
    }

    func testViewerWithoutAParsedLevelCountsAsLevel31InEveryCheck() {
        let levels = WebRTCPublisher.h264Levels([
            (codecName: "H264", levelIdc: nil),
            (codecName: "H264", levelIdc: 52),
            (codecName: "VP8", levelIdc: nil),
        ])
        XCTAssertEqual(levels, [H264LevelPolicy.defaultLevelIdc, 52])
        // Skipping the unparsed viewer, as the post-answer check did, proposed a larger canvas than
        // the one the refresh then produced for a new level 5.2 viewer.
        let raw = Dimensions(width: 1206, height: 2622)
        let refreshed = WebRTCPublisher.canvasSize(for: raw, maxDimension: 0, levels: levels + [52], scale: 1)
        let skipped = WebRTCPublisher.canvasSize(for: raw, maxDimension: 0, levels: [52, 52], scale: 1)
        XCTAssertLessThan(refreshed.width * refreshed.height, skipped.width * skipped.height)
    }

}
