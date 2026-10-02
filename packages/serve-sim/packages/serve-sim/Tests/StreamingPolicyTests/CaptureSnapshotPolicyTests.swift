import XCTest
@testable import StreamingPolicy

final class CaptureSnapshotPolicyTests: XCTestCase {
    func testRecordingAlwaysCapturesNative() {
        XCTAssertEqual(CaptureSnapshotPolicy.maxDimension(
            recording: true, otherConsumers: true, configuredMaxDimension: 800, viewerCanvasLongEdge: 1392), 0)
    }

    func testOtherConsumersKeepTheConfiguredSize() {
        XCTAssertEqual(CaptureSnapshotPolicy.maxDimension(
            recording: false, otherConsumers: true, configuredMaxDimension: 0, viewerCanvasLongEdge: 1392), 0)
        XCTAssertEqual(CaptureSnapshotPolicy.maxDimension(
            recording: false, otherConsumers: true, configuredMaxDimension: 800, viewerCanvasLongEdge: 1392), 800)
    }

    func testViewersAloneCaptureAtTheCanvas() {
        XCTAssertEqual(CaptureSnapshotPolicy.maxDimension(
            recording: false, otherConsumers: false, configuredMaxDimension: 0, viewerCanvasLongEdge: 1392), 1392)
        XCTAssertEqual(CaptureSnapshotPolicy.maxDimension(
            recording: false, otherConsumers: false, configuredMaxDimension: 1000, viewerCanvasLongEdge: 1392), 1000)
        XCTAssertEqual(CaptureSnapshotPolicy.maxDimension(
            recording: false, otherConsumers: false, configuredMaxDimension: 2000, viewerCanvasLongEdge: 1392), 1392)
    }

    func testNoCanvasFallsBackToTheConfiguredSize() {
        XCTAssertEqual(CaptureSnapshotPolicy.maxDimension(
            recording: false, otherConsumers: false, configuredMaxDimension: 0, viewerCanvasLongEdge: 0), 0)
        XCTAssertEqual(CaptureSnapshotPolicy.maxDimension(
            recording: false, otherConsumers: false, configuredMaxDimension: -5, viewerCanvasLongEdge: 0), 0)
    }
}
