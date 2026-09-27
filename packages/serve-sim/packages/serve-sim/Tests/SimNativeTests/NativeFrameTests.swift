import CoreMedia
import CoreVideo
import XCTest
@testable import SimNative

final class NativeFrameTests: XCTestCase {
    func testMailboxKeepsNewestOwnedFrameOnlyWhileActive() {
        let first = makeBuffer(width: 12, height: 20)
        let second = makeBuffer(width: 20, height: 12)
        let mailbox = NativeFrameMailbox()
        let timestamp = CMTime(value: 123, timescale: 1_000)
        let wallClock = Date(timeIntervalSince1970: 1_600_000_000)

        mailbox.publish(first, timestamp: timestamp, wallClock: wallClock)
        XCTAssertNil(mailbox.latest())

        mailbox.setActive(true)
        mailbox.publish(first, timestamp: timestamp, wallClock: wallClock)
        XCTAssertTrue(mailbox.latest()?.pixelBuffer === first)
        XCTAssertEqual(mailbox.latest()?.timestamp, timestamp)
        XCTAssertEqual(mailbox.latest()?.wallClock, wallClock)

        mailbox.publish(second, timestamp: timestamp + CMTime(value: 1, timescale: 1_000),
                        wallClock: wallClock.addingTimeInterval(0.001))
        XCTAssertTrue(mailbox.latest()?.pixelBuffer === second)
        mailbox.setActive(false)
        XCTAssertNil(mailbox.latest())
    }

    func testCapturePoolCanServeRetainedConsumersBeyondEightFrames() {
        let source = makeBuffer(width: 120, height: 240)
        var copier = Photocopier()
        var retained: [CVPixelBuffer] = []
        for _ in 0..<16 {
            guard let frame = copier.copy(source) else {
                XCTFail("Capture pool stopped while downstream consumers retained frames")
                return
            }
            retained.append(frame)
        }
        XCTAssertEqual(retained.count, 16)
        XCTAssertEqual(copier.poolDrops, 0)
    }

    func testLetterboxPoolCanServeRetainedConsumersBeyondEightFrames() {
        let source = makeBuffer(width: 120, height: 240)
        let letterboxer = PixelBufferLetterboxer()
        var retained: [CVPixelBuffer] = []
        for _ in 0..<16 {
            guard let frame = letterboxer.place(source, width: 320, height: 240) else {
                XCTFail("Letterbox pool stopped while WebRTC retained frames")
                return
            }
            retained.append(frame)
        }
        XCTAssertEqual(retained.count, 16)
        XCTAssertEqual(letterboxer.poolDrops, 0)
    }

    func testVideoToolboxLetterboxKeepsCanvasAndBars() {
        let source = makeBuffer(width: 120, height: 240,
                                format: kCVPixelFormatType_420YpCbCr8BiPlanarVideoRange)
        CVPixelBufferLockBaseAddress(source, [])
        memset(CVPixelBufferGetBaseAddressOfPlane(source, 0), 235,
               CVPixelBufferGetBytesPerRowOfPlane(source, 0) * CVPixelBufferGetHeight(source))
        memset(CVPixelBufferGetBaseAddressOfPlane(source, 1), 128,
               CVPixelBufferGetBytesPerRowOfPlane(source, 1) * CVPixelBufferGetHeight(source) / 2)
        CVPixelBufferUnlockBaseAddress(source, [])

        let letterboxer = PixelBufferLetterboxer()
        guard let output = letterboxer.place(source, width: 320, height: 240) else {
            XCTFail("VideoToolbox letterbox returned no frame")
            return
        }
        XCTAssertEqual(output.dimensions, Dimensions(width: 320, height: 240))
        XCTAssertEqual(letterboxer.transferFrames, 1)
        XCTAssertEqual(letterboxer.cpuFrames, 0)

        CVPixelBufferLockBaseAddress(output, .readOnly)
        defer { CVPixelBufferUnlockBaseAddress(output, .readOnly) }
        let luma = CVPixelBufferGetBaseAddressOfPlane(output, 0)!.assumingMemoryBound(to: UInt8.self)
        let stride = CVPixelBufferGetBytesPerRowOfPlane(output, 0)
        XCTAssertLessThan(luma[120 * stride + 10], 30)
        XCTAssertGreaterThan(luma[120 * stride + 160], 200)
    }

    func testNativeCopyKeepsOddSourceEdgesWithoutScaling() {
        for (width, height) in [(101, 103), (101, 104), (102, 103)] {
            assertNativeCopyKeepsEdges(width: width, height: height)
        }
    }

    func testOddNativeCopyKeepsEdgesWithoutMetal() {
        assertNativeCopyKeepsEdges(width: 101, height: 103, useMetal: false)
    }

    func testOddCapResizesInsteadOfClippingEvenWhenTransferFails() throws {
        let source = makeBuffer(width: 101, height: 103)
        CVPixelBufferLockBaseAddress(source, [])
        let sourceBytes = CVPixelBufferGetBaseAddress(source)!.assumingMemoryBound(to: UInt8.self)
        let sourceStride = CVPixelBufferGetBytesPerRow(source)
        for y in 0..<103 {
            for x in 0..<101 {
                let offset = y * sourceStride + x * 4
                let value: UInt8 = y == 102 ? 255 : 0
                sourceBytes[offset] = value
                sourceBytes[offset + 1] = value
                sourceBytes[offset + 2] = value
                sourceBytes[offset + 3] = 255
            }
        }
        CVPixelBufferUnlockBaseAddress(source, [])
        XCTAssertEqual(Photocopier.target(for: source, maxDimension: 103),
                       Dimensions(width: 102, height: 102))

        var copier = Photocopier(useMetal: false)
        let resized = try XCTUnwrap(copier.copy(source, maxDimension: 103))
        XCTAssertEqual(resized.dimensions, Dimensions(width: 102, height: 102))
        XCTAssertEqual(CVPixelBufferGetPixelFormatType(resized),
                       kCVPixelFormatType_420YpCbCr8BiPlanarVideoRange)
        CVPixelBufferLockBaseAddress(resized, .readOnly)
        let luma = CVPixelBufferGetBaseAddressOfPlane(resized, 0)!.assumingMemoryBound(to: UInt8.self)
        let lumaStride = CVPixelBufferGetBytesPerRowOfPlane(resized, 0)
        XCTAssertGreaterThan(luma[101 * lumaStride + 50], 80,
                             "the bottom source row must survive the downscale")
        CVPixelBufferUnlockBaseAddress(resized, .readOnly)

        var fallback = Photocopier(useMetal: false, useTransfer: false)
        let native = try XCTUnwrap(fallback.copy(source, maxDimension: 103))
        XCTAssertEqual(native.dimensions, Dimensions(width: 102, height: 102))
        XCTAssertEqual(fallback.cpuFallbacks, 1)
        CVPixelBufferLockBaseAddress(native, .readOnly)
        let nativeBytes = CVPixelBufferGetBaseAddress(native)!.assumingMemoryBound(to: UInt8.self)
        XCTAssertGreaterThan(nativeBytes[101 * CVPixelBufferGetBytesPerRow(native) + 50 * 4], 80)
        CVPixelBufferUnlockBaseAddress(native, .readOnly)
    }

    private func assertNativeCopyKeepsEdges(width: Int, height: Int, useMetal: Bool = true) {
        let source = makeBuffer(width: width, height: height)
        CVPixelBufferLockBaseAddress(source, [])
        let bytes = CVPixelBufferGetBaseAddress(source)!.assumingMemoryBound(to: UInt8.self)
        let stride = CVPixelBufferGetBytesPerRow(source)
        for y in 0..<height {
            for x in 0..<width {
                let offset = y * stride + x * 4
                let value: UInt8 = x == width - 1 || y == 0 || y == height - 1 ? 255 : 0
                bytes[offset] = value
                bytes[offset + 1] = value
                bytes[offset + 2] = value
                bytes[offset + 3] = 255
            }
        }
        CVPixelBufferUnlockBaseAddress(source, [])

        var copier = Photocopier(useMetal: useMetal)
        guard let output = copier.copy(source, maxDimension: 0) else {
            XCTFail("Native transfer returned no frame")
            return
        }
        let target = Dimensions(width: (width + 1) & ~1, height: (height + 1) & ~1)
        XCTAssertEqual(output.dimensions, target)
        XCTAssertEqual(CVPixelBufferGetPixelFormatType(output), kCVPixelFormatType_32BGRA)
        XCTAssertEqual(copier.cpuFallbacks, useMetal ? 0 : 1)
        CVPixelBufferLockBaseAddress(output, .readOnly)
        defer { CVPixelBufferUnlockBaseAddress(output, .readOnly) }
        let pixels = CVPixelBufferGetBaseAddress(output)!.assumingMemoryBound(to: UInt8.self)
        let outputStride = CVPixelBufferGetBytesPerRow(output)
        XCTAssertLessThan(pixels[50 * outputStride + (width - 2) * 4], 70)
        XCTAssertGreaterThan(pixels[50 * outputStride + (width - 1) * 4], 180)
        XCTAssertGreaterThan(pixels[50 * 4], 180)
        XCTAssertLessThan(pixels[outputStride + 50 * 4], 70)
        XCTAssertGreaterThan(pixels[(height - 1) * outputStride + 50 * 4], 180)
        XCTAssertLessThan(pixels[(height - 2) * outputStride + 50 * 4], 70)
        if target.width > width {
            XCTAssertLessThan(pixels[50 * outputStride + width * 4], 70)
        }
        if target.height > height {
            XCTAssertLessThan(pixels[height * outputStride + 50 * 4], 70)
        }
    }

    private func makeBuffer(width: Int, height: Int,
                            format: OSType = kCVPixelFormatType_32BGRA) -> CVPixelBuffer {
        var buffer: CVPixelBuffer?
        let attributes: [String: Any] = [
            kCVPixelBufferPixelFormatTypeKey as String: format,
            kCVPixelBufferWidthKey as String: width,
            kCVPixelBufferHeightKey as String: height,
            kCVPixelBufferIOSurfacePropertiesKey as String: [:],
        ]
        XCTAssertEqual(CVPixelBufferCreate(kCFAllocatorDefault, width, height,
                                           format,
                                           attributes as CFDictionary, &buffer), kCVReturnSuccess)
        return buffer!
    }
}
