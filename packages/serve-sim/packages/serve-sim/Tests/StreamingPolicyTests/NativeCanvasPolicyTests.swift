import XCTest
@testable import StreamingPolicy

final class NativeCanvasPolicyTests: XCTestCase {
    func testCanvasContainsBothFoldStatesWithoutShrinkingEitherPanel() {
        let canvas = NativeCanvasPolicy.canvas(for: [
            NativeCanvasSize(width: 1_206, height: 2_622),
            NativeCanvasSize(width: 2_080, height: 1_848),
        ])
        XCTAssertEqual(canvas, NativeCanvasSize(width: 2_080, height: 2_622))

        for panel in [NativeCanvasSize(width: 1_206, height: 2_622),
                      NativeCanvasSize(width: 2_080, height: 1_848)] {
            let placement = LetterboxPlacement(
                sourceWidth: panel.width, sourceHeight: panel.height,
                canvasWidth: canvas!.width, canvasHeight: canvas!.height
            )
            XCTAssertEqual(placement.width, panel.width)
            XCTAssertEqual(placement.height, panel.height)
        }
    }

    func testOddPanelEdgesMatchEvenNativeSnapshots() {
        XCTAssertEqual(NativeCanvasPolicy.canvas(for: [
            NativeCanvasSize(width: 1_206, height: 2_622),
            NativeCanvasSize(width: 2_007, height: 2_853),
        ]), NativeCanvasSize(width: 2_008, height: 2_854))
    }

    func testEmptyAndInvalidPanels() {
        XCTAssertNil(NativeCanvasPolicy.canvas(for: []))
        XCTAssertEqual(NativeCanvasPolicy.canvas(for: [
            NativeCanvasSize(width: 0, height: 1_000),
            NativeCanvasSize(width: 1_200, height: 800),
        ]), NativeCanvasSize(width: 1_200, height: 800))
    }
}
