import CoreMedia
import CoreVideo
import LiveKitWebRTC
import XCTest
@testable import SimNative

final class SharedWebRTCEncoderTests: XCTestCase {
    private func makeFrame(_ timestampNs: Int64) -> LKRTCVideoFrame {
        var buffer: CVPixelBuffer?
        let attributes: [String: Any] = [kCVPixelBufferIOSurfacePropertiesKey as String: [:]]
        XCTAssertEqual(CVPixelBufferCreate(kCFAllocatorDefault, 64, 128, kCVPixelFormatType_420YpCbCr8BiPlanarVideoRange,
                                           attributes as CFDictionary, &buffer), kCVReturnSuccess)
        return LKRTCVideoFrame(buffer: LKRTCCVPixelBuffer(pixelBuffer: buffer!), rotation: ._0, timeStampNs: timestampNs)
    }

    private func settings() -> LKRTCVideoEncoderSettings {
        let value = LKRTCVideoEncoderSettings()
        value.width = 64
        value.height = 128
        value.startBitrate = 1_000
        value.maxFramerate = 60
        return value
    }

    /// libwebrtc releases and re-initializes an encoder when it reconfigures a stream. A proxy
    /// that lost its packetization mode on release registered no callback afterwards and never
    /// delivered again: one viewer of eight sent no video for a whole session.
    func testProxyDeliversAgainAfterReleaseAndReinitialize() throws {
        let factory = SharedWebRTCEncoderFactory(bitrate: 1_000_000, fps: 60, h264Allowed: { true })
        let info = LKRTCVideoCodecInfo(name: "H264", parameters: ["packetization-mode": "1", "profile-level-id": "42e01f"])
        let proxy = try XCTUnwrap(factory.createEncoder(info))
        defer { factory.stop() }

        XCTAssertEqual(proxy.startEncode(with: settings(), numberOfCores: 2), 0)
        let first = expectation(description: "first delivery")
        first.assertForOverFulfill = false
        proxy.setCallback { _, _ in first.fulfill(); return true }
        XCTAssertEqual(proxy.encode(makeFrame(1_000_000), codecSpecificInfo: nil, frameTypes: []), 0)
        wait(for: [first], timeout: 5)

        // The reconfigure: release, start again, register a new callback.
        XCTAssertEqual(proxy.release(), 0)
        XCTAssertEqual(proxy.startEncode(with: settings(), numberOfCores: 2), 0)
        let second = expectation(description: "delivery after reinitialize")
        second.assertForOverFulfill = false
        proxy.setCallback { _, _ in second.fulfill(); return true }
        XCTAssertEqual(proxy.encode(makeFrame(2_000_000), codecSpecificInfo: nil, frameTypes: []), 0)
        wait(for: [second], timeout: 5)

        let stats = try XCTUnwrap(factory.peerStats().first)
        XCTAssertEqual(stats.starts, 2)
        XCTAssertEqual(stats.releases, 1)
        XCTAssertEqual(stats.callbackSets, 2)
        XCTAssertEqual(stats.missingCallback, 0)
        XCTAssertGreaterThanOrEqual(stats.deliveries, 2)
        XCTAssertTrue(stats.live)
    }

    func testDestroyedProxyDoesNotRetainPeerState() throws {
        let factory = SharedWebRTCEncoderFactory(bitrate: 1_000_000, fps: 60, h264Allowed: { true })
        let info = LKRTCVideoCodecInfo(name: "H264", parameters: ["packetization-mode": "1"])
        var proxy: (any LKRTCVideoEncoder)? = factory.createEncoder(info)
        XCTAssertNotNil(proxy)
        XCTAssertEqual(factory.peerStats().count, 1)

        XCTAssertEqual(proxy?.release(), 0)
        XCTAssertEqual(factory.peerStats().count, 1)
        proxy = nil
        XCTAssertTrue(factory.peerStats().isEmpty)
    }

    func testPeerThatMissesDeltaReceivesNextSharedKeyframe() throws {
        let factory = SharedWebRTCEncoderFactory(bitrate: 1_000_000, fps: 60, h264Allowed: { true })
        let info = LKRTCVideoCodecInfo(name: "H264", parameters: ["packetization-mode": "1"])
        let first = try XCTUnwrap(factory.createEncoder(info))
        let second = try XCTUnwrap(factory.createEncoder(info))
        defer { factory.stop() }

        XCTAssertEqual(first.startEncode(with: settings(), numberOfCores: 2), 0)
        XCTAssertEqual(second.startEncode(with: settings(), numberOfCores: 2), 0)

        let firstReceived = (1...4).map { expectation(description: "first peer frame \($0)") }
        let secondFirstFrame = expectation(description: "second peer first frame")
        let secondRecovery = expectation(description: "second peer recovered with keyframe")
        var firstFrames: [LKRTCFrameType] = []
        var secondFrames: [LKRTCFrameType] = []
        first.setCallback { image, _ in
            firstFrames.append(image.frameType)
            firstReceived[firstFrames.count - 1].fulfill()
            return true
        }
        second.setCallback { image, _ in
            secondFrames.append(image.frameType)
            if secondFrames.count == 1 { secondFirstFrame.fulfill() }
            if secondFrames.count > 1, image.frameType == .videoFrameKey { secondRecovery.fulfill() }
            return true
        }

        XCTAssertEqual(first.encode(makeFrame(1_000_000), codecSpecificInfo: nil, frameTypes: []), 0)
        XCTAssertEqual(second.encode(makeFrame(1_000_000), codecSpecificInfo: nil, frameTypes: []), 0)
        wait(for: [firstReceived[0], secondFirstFrame], timeout: 5)

        XCTAssertEqual(first.encode(makeFrame(2_000_000), codecSpecificInfo: nil, frameTypes: []), 0)
        wait(for: [firstReceived[1]], timeout: 5)

        XCTAssertEqual(second.encode(makeFrame(3_000_000), codecSpecificInfo: nil, frameTypes: []), 0)
        XCTAssertEqual(first.encode(makeFrame(3_000_000), codecSpecificInfo: nil, frameTypes: []), 0)
        wait(for: [firstReceived[2]], timeout: 5)
        XCTAssertEqual(factory.peerStats().first { $0.peer == 2 }?.deliveries, 1)

        XCTAssertEqual(first.encode(makeFrame(4_000_000), codecSpecificInfo: nil, frameTypes: []), 0)
        wait(for: [firstReceived[3], secondRecovery], timeout: 5)
        XCTAssertEqual(firstFrames[2], .videoFrameDelta)
        XCTAssertEqual(secondFrames, [.videoFrameKey, .videoFrameKey])
    }

    /// A peer whose callback rejects frames (its sender is not active yet, or paused) waits for a
    /// keyframe. It must not force one after every keyframe it rejects: every other viewer would
    /// then receive a keyframe-only stream until it starts accepting.
    func testRejectingPeerDoesNotForceKeyframesOnTheOthers() throws {
        let factory = SharedWebRTCEncoderFactory(bitrate: 1_000_000, fps: 60, h264Allowed: { true })
        let info = LKRTCVideoCodecInfo(name: "H264", parameters: ["packetization-mode": "1"])
        let first = try XCTUnwrap(factory.createEncoder(info))
        let second = try XCTUnwrap(factory.createEncoder(info))
        defer { factory.stop() }
        XCTAssertEqual(first.startEncode(with: settings(), numberOfCores: 2), 0)
        XCTAssertEqual(second.startEncode(with: settings(), numberOfCores: 2), 0)

        let frames = 8
        let firstReceived = (0...frames).map { expectation(description: "first peer frame \($0 + 1)") }
        let secondRecovered = expectation(description: "second peer recovered with a keyframe")
        var firstFrames: [LKRTCFrameType] = []
        var rejecting = true
        var rejected = 0
        first.setCallback { image, _ in
            firstFrames.append(image.frameType)
            firstReceived[firstFrames.count - 1].fulfill()
            return true
        }
        second.setCallback { image, _ in
            if rejecting { rejected += 1; return false }
            if image.frameType == .videoFrameKey { secondRecovered.fulfill() }
            return true
        }

        for n in 1...frames {
            let timestamp = Int64(n) * 1_000_000
            XCTAssertEqual(first.encode(makeFrame(timestamp), codecSpecificInfo: nil, frameTypes: []), 0)
            XCTAssertEqual(second.encode(makeFrame(timestamp), codecSpecificInfo: nil, frameTypes: []), 0)
            wait(for: [firstReceived[n - 1]], timeout: 5)
        }
        XCTAssertGreaterThan(rejected, 0)
        // The join forces a keyframe, and the first refusal one more; the frames are 1 ms apart,
        // so later refusals force none and the first peer gets deltas.
        XCTAssertEqual(firstFrames.first, .videoFrameKey)
        XCTAssertLessThanOrEqual(firstFrames.dropFirst().filter { $0 == .videoFrameKey }.count, 1,
                                 "keyframes after the join: \(firstFrames.map(\.rawValue))")
        XCTAssertGreaterThanOrEqual(firstFrames.suffix(frames - 2).filter { $0 == .videoFrameDelta }.count, frames - 3)

        // Once the second peer accepts, its keyframe request recovers it.
        rejecting = false
        let timestamp = Int64(frames + 1) * 1_000_000
        let keyframe = [NSNumber(value: LKRTCFrameType.videoFrameKey.rawValue)]
        XCTAssertEqual(second.encode(makeFrame(timestamp), codecSpecificInfo: nil, frameTypes: keyframe), 0)
        XCTAssertEqual(first.encode(makeFrame(timestamp), codecSpecificInfo: nil, frameTypes: []), 0)
        wait(for: [firstReceived[frames], secondRecovered], timeout: 5)
    }


    /// A new viewer's sender can refuse the join keyframe before it is active. It must still start
    /// on the next frame, not wait for the periodic keyframe.
    func testPeerThatRefusesItsFirstKeyframeStartsOnTheNextFrame() throws {
        let factory = SharedWebRTCEncoderFactory(bitrate: 1_000_000, fps: 60, h264Allowed: { true })
        let info = LKRTCVideoCodecInfo(name: "H264", parameters: ["packetization-mode": "1"])
        let proxy = try XCTUnwrap(factory.createEncoder(info))
        defer { factory.stop() }
        XCTAssertEqual(proxy.startEncode(with: settings(), numberOfCores: 2), 0)

        let refused = expectation(description: "join keyframe refused")
        let started = expectation(description: "next frame accepted")
        var calls: [LKRTCFrameType] = []
        proxy.setCallback { image, _ in
            calls.append(image.frameType)
            if calls.count == 1 { refused.fulfill(); return false }
            if calls.count == 2 { started.fulfill() }
            return true
        }
        XCTAssertEqual(proxy.encode(makeFrame(1_000_000), codecSpecificInfo: nil, frameTypes: []), 0)
        wait(for: [refused], timeout: 5)
        XCTAssertEqual(proxy.encode(makeFrame(2_000_000), codecSpecificInfo: nil, frameTypes: []), 0)
        wait(for: [started], timeout: 5)
        XCTAssertEqual(calls, [.videoFrameKey, .videoFrameKey])
    }

    /// The fallback to default rate control shows in /webrtc/stats, not only in a debug log.
    /// VideoToolbox drops the second frame of a low-latency 320x640 session on Apple silicon hosts,
    /// and the fallback that follows sends that frame as a keyframe.
    func testFallbackShowsInTheSharedCount() throws {
        let factory = SharedWebRTCEncoderFactory(bitrate: 500_000, fps: 60, h264Allowed: { true })
        let info = LKRTCVideoCodecInfo(name: "H264", parameters: ["packetization-mode": "1"])
        let proxy = try XCTUnwrap(factory.createEncoder(info))
        defer { factory.stop() }
        let settings = settings()
        settings.width = 320
        settings.height = 640
        settings.startBitrate = 500
        XCTAssertEqual(proxy.startEncode(with: settings, numberOfCores: 2), 0)

        var buffer: CVPixelBuffer?
        let attributes: [String: Any] = [kCVPixelBufferIOSurfacePropertiesKey as String: [:]]
        XCTAssertEqual(CVPixelBufferCreate(kCFAllocatorDefault, 320, 640, kCVPixelFormatType_420YpCbCr8BiPlanarVideoRange,
                                           attributes as CFDictionary, &buffer), kCVReturnSuccess)
        let pixels = try XCTUnwrap(buffer)
        CVPixelBufferLockBaseAddress(pixels, [])
        for plane in 0..<2 {
            memset(CVPixelBufferGetBaseAddressOfPlane(pixels, plane), 128,
                   CVPixelBufferGetBytesPerRowOfPlane(pixels, plane) * CVPixelBufferGetHeightOfPlane(pixels, plane))
        }
        CVPixelBufferUnlockBaseAddress(pixels, [])

        var delivered: [LKRTCFrameType] = []
        var arrived = XCTestExpectation(description: "a frame")
        proxy.setCallback { image, _ in
            delivered.append(image.frameType)
            arrived.fulfill()
            return true
        }
        for n in Int64(1)...2 {
            arrived = expectation(description: "frame \(n)")
            let frame = LKRTCVideoFrame(buffer: LKRTCCVPixelBuffer(pixelBuffer: pixels), rotation: ._0,
                                        timeStampNs: n * 1_000_000)
            XCTAssertEqual(proxy.encode(frame, codecSpecificInfo: nil, frameTypes: []), 0)
            wait(for: [arrived], timeout: 5)
        }
        if delivered.last == .videoFrameDelta { throw XCTSkip("VideoToolbox kept the second frame on this host") }
        // The count is read after delivery.
        let deadline = Date().addingTimeInterval(2)
        while factory.lowLatencyFallbacks() == 0, Date() < deadline { usleep(10_000) }
        XCTAssertEqual(factory.lowLatencyFallbacks(), 1)
    }
}
