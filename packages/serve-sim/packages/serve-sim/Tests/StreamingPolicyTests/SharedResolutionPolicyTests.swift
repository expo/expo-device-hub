import XCTest
@testable import StreamingPolicy

final class SharedResolutionPolicyTests: XCTestCase {
    private func seconds(_ value: Double) -> UInt64 { UInt64(value * 1_000_000_000) }
    private let target = 6_000_000

    func testSteadyBitrateAtTargetKeepsFullScale() {
        var policy = SharedResolutionPolicy(targetBitrate: target)
        for second in 0..<60 {
            XCTAssertFalse(policy.observe(bitrate: target, atNanoseconds: seconds(Double(second))))
        }
        XCTAssertEqual(policy.scale, 1.0)
        XCTAssertEqual(policy.changes, 0)
    }

    func testSustainedShortfallStepsDownOnceThenHolds() {
        var policy = SharedResolutionPolicy(targetBitrate: target)
        let low = target / 5
        XCTAssertFalse(policy.observe(bitrate: low, atNanoseconds: seconds(0)))
        XCTAssertFalse(policy.observe(bitrate: low, atNanoseconds: seconds(1.9)))
        XCTAssertTrue(policy.observe(bitrate: low, atNanoseconds: seconds(2)))
        XCTAssertEqual(policy.scale, 0.75)
        // Still short, but the hold after a step blocks the next step for 10 s.
        XCTAssertFalse(policy.observe(bitrate: low, atNanoseconds: seconds(5)))
        XCTAssertFalse(policy.observe(bitrate: low, atNanoseconds: seconds(11.9)))
        XCTAssertFalse(policy.observe(bitrate: low, atNanoseconds: seconds(12)))
        XCTAssertTrue(policy.observe(bitrate: low, atNanoseconds: seconds(14)))
        XCTAssertEqual(policy.scale, 0.5)
        // The floor.
        XCTAssertFalse(policy.observe(bitrate: low, atNanoseconds: seconds(40)))
        XCTAssertEqual(policy.scale, 0.5)
        XCTAssertEqual(policy.changes, 2)
    }

    func testBriefShortfallDoesNotStep() {
        var policy = SharedResolutionPolicy(targetBitrate: target)
        XCTAssertFalse(policy.observe(bitrate: target / 5, atNanoseconds: seconds(0)))
        XCTAssertFalse(policy.observe(bitrate: target / 5, atNanoseconds: seconds(1)))
        XCTAssertFalse(policy.observe(bitrate: target / 2, atNanoseconds: seconds(1.5)))
        XCTAssertFalse(policy.observe(bitrate: target / 5, atNanoseconds: seconds(2)))
        XCTAssertFalse(policy.observe(bitrate: target / 5, atNanoseconds: seconds(3.9)))
        XCTAssertEqual(policy.scale, 1.0)
    }

    func testHeadroomStepsUpOnlyAfterTenSeconds() {
        var policy = SharedResolutionPolicy(targetBitrate: target)
        XCTAssertFalse(policy.observe(bitrate: target / 5, atNanoseconds: seconds(0)))
        XCTAssertTrue(policy.observe(bitrate: target / 5, atNanoseconds: seconds(2)))
        // Hold until 12 s, then 10 s of headroom.
        XCTAssertFalse(policy.observe(bitrate: target, atNanoseconds: seconds(12)))
        XCTAssertFalse(policy.observe(bitrate: target, atNanoseconds: seconds(21.9)))
        XCTAssertTrue(policy.observe(bitrate: target, atNanoseconds: seconds(22)))
        XCTAssertEqual(policy.scale, 1.0)
    }

    func testJoinHoldIgnoresARampingPeer() {
        var policy = SharedResolutionPolicy(targetBitrate: target)
        policy.peerJoined(atNanoseconds: seconds(0))
        XCTAssertFalse(policy.observe(bitrate: 300_000, atNanoseconds: seconds(0)))
        XCTAssertFalse(policy.observe(bitrate: 300_000, atNanoseconds: seconds(4.9)))
        // The window starts after the hold, not at the first low sample.
        XCTAssertFalse(policy.observe(bitrate: 300_000, atNanoseconds: seconds(5)))
        XCTAssertFalse(policy.observe(bitrate: 300_000, atNanoseconds: seconds(6.9)))
        XCTAssertTrue(policy.observe(bitrate: 300_000, atNanoseconds: seconds(7)))
    }

    func testCanvasLongEdgeScalesTheLimitOrTheSource() {
        XCTAssertEqual(SharedResolutionPolicy.canvasLongEdge(baseLimit: 1392, sourceLongEdge: 2622, scale: 1.0), 1392)
        XCTAssertEqual(SharedResolutionPolicy.canvasLongEdge(baseLimit: 0, sourceLongEdge: 2622, scale: 1.0), 0)
        XCTAssertEqual(SharedResolutionPolicy.canvasLongEdge(baseLimit: 1392, sourceLongEdge: 2622, scale: 0.75), 1044)
        XCTAssertEqual(SharedResolutionPolicy.canvasLongEdge(baseLimit: 1392, sourceLongEdge: 2622, scale: 0.5), 696)
        XCTAssertEqual(SharedResolutionPolicy.canvasLongEdge(baseLimit: 0, sourceLongEdge: 2622, scale: 0.5), 1311)
    }
}
