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
}
