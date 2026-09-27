import XCTest
@testable import SimNative
import StreamingPolicy

final class SharedCanvasAdmissionTests: XCTestCase {
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
}
