import XCTest
@testable import StreamingPolicy

final class SharedH264PolicyTests: XCTestCase {
    func testOneEncodePerTimestamp() {
        var policy = SharedH264Policy(defaultBitrate: 6_000_000)
        policy.join(peer: 1, bitrate: 4_000_000)
        policy.join(peer: 2, bitrate: 2_000_000)

        XCTAssertEqual(policy.beginFrame(timestamp: 100, requestedIDR: false), true)
        XCTAssertNil(policy.beginFrame(timestamp: 100, requestedIDR: false))
        XCTAssertEqual(policy.beginFrame(timestamp: 101, requestedIDR: false), false)
        XCTAssertNil(policy.beginFrame(timestamp: 100, requestedIDR: false))
    }

    func testBitrateUsesSlowestPeer() {
        var policy = SharedH264Policy(defaultBitrate: 6_000_000)
        policy.join(peer: 1, bitrate: 4_000_000)
        policy.join(peer: 2, bitrate: 2_000_000)
        XCTAssertEqual(policy.bitrate, 2_000_000)
        policy.setBitrate(1_000_000, peer: 2)
        XCTAssertEqual(policy.bitrate, 1_000_000)
        policy.leave(peer: 2)
        XCTAssertEqual(policy.bitrate, 4_000_000)
    }

    func testJoinAndPliForceIDR() {
        var policy = SharedH264Policy(defaultBitrate: 6_000_000)
        policy.join(peer: 1, bitrate: 6_000_000)
        XCTAssertEqual(policy.beginFrame(timestamp: 1, requestedIDR: false), true)
        XCTAssertEqual(policy.beginFrame(timestamp: 2, requestedIDR: false), false)
        XCTAssertEqual(policy.beginFrame(timestamp: 3, requestedIDR: true), true)
        policy.join(peer: 2, bitrate: 5_000_000)
        XCTAssertEqual(policy.beginFrame(timestamp: 4, requestedIDR: false), true)
    }

    func testStalePeerGetsTheNextKeyframe() {
        var policy = SharedH264Policy(defaultBitrate: 6_000_000)
        policy.join(peer: 1, bitrate: 6_000_000)
        policy.join(peer: 2, bitrate: 6_000_000)
        XCTAssertEqual(policy.beginFrame(timestamp: 10, requestedIDR: false), true)
        XCTAssertEqual(policy.beginFrame(timestamp: 11, requestedIDR: false), false)
        // Peer 2 lags: its call brings an older timestamp than the newest frame.
        XCTAssertNil(policy.beginFrame(timestamp: 9, requestedIDR: false))
        XCTAssertTrue(policy.frameWasStale(peer: 2))
        XCTAssertFalse(policy.frameWasStale(peer: 2), "marked once")
        XCTAssertTrue(policy.isAnyPeerStarved)
        // The next frame is a keyframe, and it also goes to the starved peer.
        XCTAssertEqual(policy.beginFrame(timestamp: 12, requestedIDR: false), true)
        XCTAssertEqual(policy.takeStarvedPeers(excluding: [1]), [2])
        XCTAssertFalse(policy.isAnyPeerStarved)
        XCTAssertEqual(policy.starvedRecoveries, 1)
        XCTAssertEqual(policy.beginFrame(timestamp: 13, requestedIDR: false), false)
    }

    func testCaughtUpAndLeftPeersAreNotStarved() {
        var policy = SharedH264Policy(defaultBitrate: 6_000_000)
        policy.join(peer: 1, bitrate: 6_000_000)
        policy.join(peer: 2, bitrate: 6_000_000)
        policy.frameWasStale(peer: 1)
        policy.frameWasStale(peer: 2)
        policy.caughtUp(peer: 1)
        policy.leave(peer: 2)
        XCTAssertFalse(policy.isAnyPeerStarved)
        XCTAssertEqual(policy.takeStarvedPeers(excluding: []), [])
        XCTAssertEqual(policy.starvedRecoveries, 0)
    }

    func testLetterboxPreservesCanvasAndAspect() {
        let folded = LetterboxPlacement(sourceWidth: 500, sourceHeight: 1_000,
                                         canvasWidth: 1_200, canvasHeight: 800)
        XCTAssertEqual(folded.x, 400)
        XCTAssertEqual(folded.y, 0)
        XCTAssertEqual(folded.width, 400)
        XCTAssertEqual(folded.height, 800)

        let unfolded = LetterboxPlacement(sourceWidth: 1_200, sourceHeight: 800,
                                           canvasWidth: 1_200, canvasHeight: 800)
        XCTAssertEqual(unfolded.x, 0)
        XCTAssertEqual(unfolded.y, 0)
        XCTAssertEqual(unfolded.width, 1_200)
        XCTAssertEqual(unfolded.height, 800)

        let unevenBars = LetterboxPlacement(sourceWidth: 301, sourceHeight: 400,
                                             canvasWidth: 1_200, canvasHeight: 800)
        XCTAssertEqual(unevenBars.x % 2, 0)
        XCTAssertEqual(unevenBars.y % 2, 0)
        XCTAssertLessThanOrEqual(unevenBars.x + unevenBars.width, 1_200)
    }

    func testSlowEncoderRetainsOnlyNewestWaitingFrame() {
        var backlog = SharedFrameBacklog()
        XCTAssertEqual(backlog.submit(1), .start)
        XCTAssertEqual(backlog.submit(2), .queued(replaced: nil))
        XCTAssertEqual(backlog.submit(3), .queued(replaced: 2))
        XCTAssertEqual(backlog.submit(4), .queued(replaced: 3))
        XCTAssertEqual(backlog.encodingTimestamp, 1)
        XCTAssertEqual(backlog.queuedTimestamp, 4)
        XCTAssertEqual(backlog.complete(1), 4)
        XCTAssertNil(backlog.complete(1))
        XCTAssertNil(backlog.complete(4))
        XCTAssertEqual(backlog.submit(3), .stale)
        XCTAssertEqual(backlog.submit(5), .start)
    }

    func testFailedEncodeCanDropWaitingFrameAndRecover() {
        var backlog = SharedFrameBacklog()
        XCTAssertEqual(backlog.submit(10), .start)
        XCTAssertEqual(backlog.submit(11), .queued(replaced: nil))
        backlog.discardQueued()
        XCTAssertNil(backlog.queuedTimestamp)
        XCTAssertNil(backlog.complete(10))
        XCTAssertEqual(backlog.submit(12), .start)
        backlog.stop()
        XCTAssertNil(backlog.encodingTimestamp)
        XCTAssertNil(backlog.complete(12))
    }

    func testReplacingQueuedIDRPreservesKeyframeRequest() {
        var policy = SharedH264Policy(defaultBitrate: 6_000_000)
        var backlog = SharedFrameBacklog()
        XCTAssertEqual(policy.beginFrame(timestamp: 1, requestedIDR: false), false)
        XCTAssertEqual(backlog.submit(1), .start)
        policy.requestIDR()
        let queuedIDR = policy.beginFrame(timestamp: 2, requestedIDR: false)
        XCTAssertEqual(queuedIDR, true)
        XCTAssertEqual(backlog.submit(2), .queued(replaced: nil))
        if queuedIDR == true { policy.requestIDR() }
        XCTAssertEqual(policy.beginFrame(timestamp: 3, requestedIDR: false), true)
        XCTAssertEqual(backlog.submit(3), .queued(replaced: 2))
        XCTAssertEqual(backlog.complete(1), 3)
    }
}
