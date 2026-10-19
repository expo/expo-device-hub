import CoreMedia
import CoreVideo
import Foundation
import LiveKitWebRTC
import XCTest
@testable import SimNative

/// Controls the asynchronous encode boundary, while the real shared encoder owns
/// admission, backlog, cache, Annex-B conversion, and peer callbacks.
private final class ControlledRebootEncode: @unchecked Sendable {
    private let lock = NSLock()
    private let started: [XCTestExpectation]
    private var pending: [Int: CheckedContinuation<H264Encoder.Encoded?, Never>] = [:]
    private var submissions: [(marker: UInt8, forceIDR: Bool)] = []

    init(started: [XCTestExpectation]) { self.started = started }

    func encode(_ buffer: CVPixelBuffer, forceIDR: Bool) async -> H264Encoder.Encoded? {
        await withCheckedContinuation { continuation in
            CVPixelBufferLockBaseAddress(buffer, .readOnly)
            let marker = CVPixelBufferGetBaseAddressOfPlane(buffer, 0)!.load(as: UInt8.self)
            CVPixelBufferUnlockBaseAddress(buffer, .readOnly)
            lock.lock()
            let index = submissions.count
            submissions.append((marker, forceIDR))
            pending[index] = continuation
            lock.unlock()
            if index < started.count { started[index].fulfill() }
        }
    }

    func snapshot() -> [(marker: UInt8, forceIDR: Bool)] {
        lock.lock()
        defer { lock.unlock() }
        return submissions
    }

    func finish(_ index: Int, malformed: Bool = false, missing: Bool = false) {
        lock.lock()
        guard let continuation = pending.removeValue(forKey: index) else {
            lock.unlock()
            XCTFail("Expected an active encode at index \(index)")
            return
        }
        let forceIDR = submissions[index].forceIDR
        lock.unlock()
        if missing { continuation.resume(returning: nil); return }
        // Structurally valid AVCC for the real Annex-B fan-out; no decoder is used.
        continuation.resume(returning: .init(
            description: nil, kind: forceIDR ? .keyframe : .delta,
            avcc: Data([0, 0, 0, malformed ? 5 : 1, forceIDR ? 0x65 : 0x41]),
            parameterSets: [Data([0x67, 0x42, 0, 0x1f]), Data([0x68, 0xce, 0x06, 0xe2])]
        ))
    }

    func cancel() {
        lock.lock()
        let continuations = Array(pending.values)
        pending.removeAll()
        lock.unlock()
        continuations.forEach { $0.resume(returning: nil) }
    }
}

final class SharedWebRTCEncoderRebootTests: XCTestCase {
    func testFlowCountersDistinguishCoalescingFromEncodeFailure() throws {
        let firstStarted = expectation(description: "first encode")
        let latestStarted = expectation(description: "latest queued encode")
        let control = ControlledRebootEncode(started: [firstStarted, latestStarted])
        let factory = SharedWebRTCEncoderFactory(bitrate: 1_000_000, fps: 60, h264Allowed: { true },
                                                encodeFrame: { buffer, forceIDR, _, _ in
                                                    await control.encode(buffer, forceIDR: forceIDR)
                                                })
        defer { factory.stop(); control.cancel() }
        let sender = try proxy(factory)
        let deliveries = expectation(description: "two deliveries")
        deliveries.expectedFulfillmentCount = 2
        sender.setCallback { _, _ in deliveries.fulfill(); return true }
        XCTAssertEqual(sender.encode(try frame(1, marker: 1, factory: factory), codecSpecificInfo: nil, frameTypes: []), 0)
        wait(for: [firstStarted], timeout: 2)
        for marker: UInt8 in [2, 3, 4] {
            XCTAssertEqual(sender.encode(try frame(Int64(marker), marker: marker, factory: factory), codecSpecificInfo: nil, frameTypes: []), 0)
        }
        XCTAssertEqual(factory.flowStats().submitted, 1)
        XCTAssertEqual(factory.flowStats().coalesced, 2)
        control.finish(0)
        wait(for: [latestStarted], timeout: 2)
        XCTAssertEqual(control.snapshot().map(\.marker), [1, 4])
        control.finish(1)
        wait(for: [deliveries], timeout: 2)
        let flow = factory.flowStats()
        XCTAssertEqual(flow.submitted, 2)
        XCTAssertEqual(flow.completed, 2)
        XCTAssertEqual(flow.failed, 0)
        XCTAssertGreaterThan(flow.encodeSumMs, 0)
        XCTAssertGreaterThan(flow.queueWaitSumMs, 0)
    }

    func testFlowCountsUndeliverableAvccAndRecoversWithKeyframe() throws {
        try assertFailedResultRecovery(missing: false)
    }

    func testFlowCountsNilResultOnceAndRecoversWithKeyframe() throws {
        try assertFailedResultRecovery(missing: true)
    }

    private func assertFailedResultRecovery(missing: Bool) throws {
        let firstStarted = expectation(description: "malformed encode")
        let recoveryStarted = expectation(description: "recovery encode")
        let control = ControlledRebootEncode(started: [firstStarted, recoveryStarted])
        let factory = SharedWebRTCEncoderFactory(bitrate: 1_000_000, fps: 60, h264Allowed: { true },
                                                encodeFrame: { buffer, forceIDR, _, _ in
                                                    await control.encode(buffer, forceIDR: forceIDR)
                                                })
        defer { factory.stop(); control.cancel() }
        let sender = try proxy(factory)
        let delivered = expectation(description: "only recovery delivered")
        sender.setCallback { image, _ in
            XCTAssertEqual(image.captureTimeMs, 2)
            XCTAssertEqual(image.frameType, .videoFrameKey)
            delivered.fulfill()
            return true
        }
        XCTAssertEqual(sender.encode(try frame(1, marker: 1, factory: factory), codecSpecificInfo: nil, frameTypes: []), 0)
        wait(for: [firstStarted], timeout: 2)
        XCTAssertEqual(sender.encode(try frame(2, marker: 2, factory: factory), codecSpecificInfo: nil, frameTypes: []), 0)
        control.finish(0, malformed: true, missing: missing)
        wait(for: [recoveryStarted], timeout: 2)
        XCTAssertTrue(control.snapshot()[1].forceIDR)
        control.finish(1)
        wait(for: [delivered], timeout: 2)
        XCTAssertEqual(factory.flowStats().completed, 2)
        XCTAssertEqual(factory.flowStats().failed, 1)
    }

    private func frame(_ timestampMs: Int64, marker: UInt8, factory: SharedWebRTCEncoderFactory,
                       accepted: Bool = true) throws -> LKRTCVideoFrame {
        var buffer: CVPixelBuffer?
        XCTAssertEqual(CVPixelBufferCreate(kCFAllocatorDefault, 64, 128,
                                          kCVPixelFormatType_420YpCbCr8BiPlanarVideoRange,
                                          [kCVPixelBufferIOSurfacePropertiesKey as String: [:]] as CFDictionary,
                                          &buffer), kCVReturnSuccess)
        let pixels = try XCTUnwrap(buffer)
        CVPixelBufferLockBaseAddress(pixels, [])
        CVPixelBufferGetBaseAddressOfPlane(pixels, 0)!.storeBytes(of: marker, as: UInt8.self)
        CVPixelBufferUnlockBaseAddress(pixels, [])
        XCTAssertEqual(factory.prepareFrame(pixels), accepted)
        return LKRTCVideoFrame(buffer: LKRTCCVPixelBuffer(pixelBuffer: pixels), rotation: ._0,
                              timeStampNs: timestampMs * 1_000_000)
    }

    private func proxy(_ factory: SharedWebRTCEncoderFactory) throws -> any LKRTCVideoEncoder {
        let info = LKRTCVideoCodecInfo(name: "H264", parameters: ["packetization-mode": "1"])
        let proxy = try XCTUnwrap(factory.createEncoder(info))
        let settings = LKRTCVideoEncoderSettings()
        settings.width = 64
        settings.height = 128
        settings.startBitrate = 1_000
        settings.maxFramerate = 60
        XCTAssertEqual(proxy.startEncode(with: settings, numberOfCores: 2), 0)
        return proxy
    }

    func testSuspensionDropsPendingAndQueuedEncoderWork() throws {
        let oldStarted = expectation(description: "old frame encoding")
        let freshStarted = expectation(description: "fresh frame encoding")
        let control = ControlledRebootEncode(started: [oldStarted, freshStarted])
        let factory = SharedWebRTCEncoderFactory(bitrate: 1_000_000, fps: 60, h264Allowed: { true },
                                                encodeFrame: { buffer, forceIDR, _, _ in
                                                    await control.encode(buffer, forceIDR: forceIDR)
                                                })
        defer { factory.stop(); control.cancel() }
        let sender = try proxy(factory)
        let staleDelivery = expectation(description: "no old frame while suspended")
        staleDelivery.isInverted = true
        staleDelivery.assertForOverFulfill = false
        let freshDelivery = expectation(description: "first resumed frame delivered")
        sender.setCallback { image, _ in
            if image.captureTimeMs < 4 { staleDelivery.fulfill() }
            if image.captureTimeMs == 4 {
                XCTAssertEqual(image.frameType, .videoFrameKey)
                freshDelivery.fulfill()
            }
            return true
        }
        XCTAssertEqual(sender.encode(try frame(1, marker: 1, factory: factory), codecSpecificInfo: nil, frameTypes: []), 0)
        wait(for: [oldStarted], timeout: 2)
        XCTAssertEqual(sender.encode(try frame(2, marker: 2, factory: factory), codecSpecificInfo: nil, frameTypes: []), 0)
        factory.suspendForReboot()
        XCTAssertEqual(sender.encode(try frame(3, marker: 3, factory: factory, accepted: false), codecSpecificInfo: nil, frameTypes: []), 0)
        control.finish(0)
        wait(for: [staleDelivery], timeout: 0.1)

        factory.resumeAfterReboot()
        XCTAssertEqual(sender.encode(try frame(4, marker: 4, factory: factory), codecSpecificInfo: nil, frameTypes: []), 0)
        wait(for: [freshStarted], timeout: 2)
        XCTAssertEqual(control.snapshot().map(\.marker), [1, 4])
        XCTAssertEqual(control.snapshot().map(\.forceIDR), [true, true])
        control.finish(1)
        wait(for: [freshDelivery], timeout: 2)
        let stats = try XCTUnwrap(factory.peerStats().first)
        XCTAssertEqual(stats.deliveries, 1)
        XCTAssertEqual(stats.starts, 1)
        XCTAssertEqual(stats.releases, 0)
        XCTAssertTrue(stats.live)
    }

    func testResumeRejectsOldCompletionCacheAndDelayedProxySubmissions() throws {
        let cachedStarted = expectation(description: "cached frame encoding")
        let oldStarted = expectation(description: "old frame encoding")
        let freshStarted = expectation(description: "fresh frame encoding after old completion drains")
        let control = ControlledRebootEncode(started: [cachedStarted, oldStarted, freshStarted])
        let factory = SharedWebRTCEncoderFactory(bitrate: 1_000_000, fps: 60, h264Allowed: { true },
                                                encodeFrame: { buffer, forceIDR, _, _ in
                                                    await control.encode(buffer, forceIDR: forceIDR)
                                                })
        defer { factory.stop(); control.cancel() }
        let sender = try proxy(factory)
        let latePeer = try proxy(factory)
        let cachedDelivery = expectation(description: "pre-reboot frame delivered")
        let freshDelivery = expectation(description: "fresh frame delivered")
        let lateFreshDelivery = expectation(description: "fresh cache delivered to retained peer")
        sender.setCallback { image, _ in
            if image.captureTimeMs == 1 { cachedDelivery.fulfill() }
            else {
                XCTAssertEqual(image.captureTimeMs, 4, "old completion must not restart delivery")
                XCTAssertEqual(image.frameType, .videoFrameKey)
                if image.captureTimeMs == 4 { freshDelivery.fulfill() }
            }
            return true
        }
        latePeer.setCallback { image, _ in
            XCTAssertEqual(image.captureTimeMs, 4, "old cached/pending timestamps must remain fenced after resume")
            XCTAssertEqual(image.frameType, .videoFrameKey)
            if image.captureTimeMs == 4 { lateFreshDelivery.fulfill() }
            return true
        }
        // Keep the actual old source buffers alive across the epoch change.
        let cachedFrame = try frame(1, marker: 1, factory: factory)
        let oldFrame = try frame(2, marker: 2, factory: factory)
        let queuedFrame = try frame(3, marker: 3, factory: factory)
        XCTAssertEqual(sender.encode(cachedFrame, codecSpecificInfo: nil, frameTypes: []), 0)
        wait(for: [cachedStarted], timeout: 2)
        control.finish(0)
        wait(for: [cachedDelivery], timeout: 2)
        XCTAssertEqual(sender.encode(oldFrame, codecSpecificInfo: nil, frameTypes: []), 0)
        wait(for: [oldStarted], timeout: 2)
        XCTAssertEqual(sender.encode(queuedFrame, codecSpecificInfo: nil, frameTypes: []), 0)
        factory.suspendForReboot()
        factory.resumeAfterReboot()
        for old in [cachedFrame, oldFrame, queuedFrame] {
            XCTAssertEqual(latePeer.encode(old, codecSpecificInfo: nil, frameTypes: []), 0)
        }
        // libwebrtc translates source timestamps before the proxy receives them.
        // The old buffer stays rejected even when its translated timestamp is newer.
        let oldPixels = try XCTUnwrap((cachedFrame.buffer as? LKRTCCVPixelBuffer)?.pixelBuffer)
        let translatedOld = LKRTCVideoFrame(buffer: LKRTCCVPixelBuffer(pixelBuffer: oldPixels), rotation: ._0,
                                           timeStampNs: 1_000_000_000)
        XCTAssertEqual(latePeer.encode(translatedOld, codecSpecificInfo: nil, frameTypes: []), 0)
        let freshFrame = try frame(4, marker: 4, factory: factory)
        XCTAssertEqual(sender.encode(freshFrame, codecSpecificInfo: nil, frameTypes: []), 0)
        control.finish(1)
        // A fresh encode starting proves the old completion drained its active slot.
        wait(for: [freshStarted], timeout: 2)
        XCTAssertEqual(control.snapshot().map(\.marker), [1, 2, 4])
        XCTAssertEqual(control.snapshot().map(\.forceIDR), [true, false, true])
        XCTAssertEqual(factory.peerStats().map(\.deliveries), [1, 0])
        control.finish(2)
        wait(for: [freshDelivery], timeout: 2)
        XCTAssertEqual(latePeer.encode(freshFrame, codecSpecificInfo: nil, frameTypes: []), 0)
        wait(for: [lateFreshDelivery], timeout: 2)
        XCTAssertEqual(factory.peerStats().map(\.deliveries), [2, 1])
    }
}
