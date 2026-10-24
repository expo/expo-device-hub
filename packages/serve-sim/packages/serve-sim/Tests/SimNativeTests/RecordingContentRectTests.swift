import CoreVideo
import Foundation
import StreamingPolicy
import XCTest
@testable import SimNative

final class RecordingContentRectTests: XCTestCase {
    func testNativeDuoPicturesAndRotationsHaveMeasuredContentBounds() throws {
        let cases: [(Int, Int, RecordingContentRect)] = [
            (2007, 2853, .init(x: 0, y: 0, width: 2007, height: 2853)),
            (1398, 2034, .init(x: 24, y: 0, width: 1960, height: 2854)),
            (2853, 2007, .init(x: 0, y: 720, width: 2008, height: 1412)),
            (2034, 1398, .init(x: 0, y: 736, width: 2008, height: 1380)),
        ]
        let letterboxer = PixelBufferLetterboxer(allowCPUFallback: false, maxBuffers: 2)
        var copier = Photocopier()
        for (width, height, expected) in cases {
            try autoreleasepool {
                let raw = try picture(width: width, height: height)
                let source = try XCTUnwrap(copier.copy(raw, maxDimension: 0))
                XCTAssertNil(CVBufferCopyAttachment(source, kCVImageBufferCleanApertureKey, nil))
                let prepared = try XCTUnwrap(letterboxer.placeForRecording(source,
                    contentSize: Dimensions(width: width, height: height), width: 2008, height: 2854))
                XCTAssertEqual(prepared.contentRect, expected)
                XCTAssertEqual(brightBounds(prepared.buffer, threshold: 20), expected)
                XCTAssertNil(CVBufferCopyAttachment(source, kCVImageBufferCleanApertureKey, nil))
                XCTAssertNil(CVBufferCopyAttachment(source, kCVImageBufferPixelAspectRatioKey, nil))
                XCTAssertNil(CVBufferCopyAttachment(prepared.buffer, kCVImageBufferCleanApertureKey, nil))
                XCTAssertNil(CVBufferCopyAttachment(prepared.buffer, kCVImageBufferPixelAspectRatioKey, nil))
            }
        }
        XCTAssertEqual(letterboxer.transferFrames, 3)
        XCTAssertEqual(letterboxer.cpuFrames, 0)
    }

    func testUpscaledOddPaddingIsExcludedAndMailboxKeepsItsFrameGeometry() throws {
        let raw = try picture(width: 99, height: 99)
        var copier = Photocopier()
        let source = try XCTUnwrap(copier.copy(raw, maxDimension: 0))
        let mailbox = NativeFrameMailbox()
        mailbox.setActive(true)
        mailbox.publish(source, timestamp: .zero, wallClock: Date(), deviceState:
            RecordingDeviceState(width: 99, height: 99, screen: .inner))
        mailbox.updateHingeState(.init(angle: 90))
        let frame = try XCTUnwrap(mailbox.latest())
        XCTAssertEqual(frame.contentSize, Dimensions(width: 99, height: 99))
        let prepared = try XCTUnwrap(PixelBufferLetterboxer(allowCPUFallback: false).placeForRecording(
            frame.pixelBuffer, contentSize: frame.contentSize, width: 200, height: 200))
        XCTAssertEqual(prepared.contentRect, .init(x: 0, y: 0, width: 198, height: 198))
        XCTAssertEqual(brightBounds(prepared.buffer, threshold: 128), prepared.contentRect)
    }

    func testRecordingTransferClearsReusedBarsAndLeavesDefaultViewerPlacementAlone() throws {
        let letterboxer = PixelBufferLetterboxer(allowCPUFallback: false, maxBuffers: 2)
        var copier = Photocopier()
        var pointers = Set<String>()
        for index in 0..<6 {
            try autoreleasepool {
                let (width, height, expected): (Int, Int, RecordingContentRect) = index % 2 == 0
                    ? (1398, 2034, .init(x: 24, y: 0, width: 1960, height: 2854))
                    : (2034, 1398, .init(x: 0, y: 736, width: 2008, height: 1380))
                let source = try XCTUnwrap(copier.copy(try picture(width: width, height: height), maxDimension: 0))
                let prepared = try XCTUnwrap(letterboxer.placeForRecording(source,
                    contentSize: source.dimensions, width: 2008, height: 2854))
                XCTAssertEqual(brightBounds(prepared.buffer, threshold: 20), expected)
                let output = prepared.buffer
                CVPixelBufferLockBaseAddress(output, [])
                defer { CVPixelBufferUnlockBaseAddress(output, []) }
                let bytes = try XCTUnwrap(CVPixelBufferGetBaseAddressOfPlane(output, 0)).assumingMemoryBound(to: UInt8.self)
                pointers.insert(String(describing: bytes))
                let stride = CVPixelBufferGetBytesPerRowOfPlane(output, 0)
                var dirtyBars = 0
                for y in 0..<2854 { for x in 0..<2008 {
                    if (x < expected.x || x >= expected.x + expected.width ||
                        y < expected.y || y >= expected.y + expected.height) && bytes[y * stride + x] != 16 {
                        dirtyBars += 1
                    }
                }}
                XCTAssertEqual(dirtyBars, 0)
                memset(bytes, 235, stride * 2854)
            }
        }
        XCTAssertLessThan(pointers.count, 6)
        let source = try XCTUnwrap(copier.copy(try picture(width: 1398, height: 2034), maxDimension: 0))
        let viewer = try XCTUnwrap(letterboxer.place(source, width: 2008, height: 2854))
        let baseline = try XCTUnwrap(PixelBufferLetterboxer(allowCPUFallback: false)
            .place(source, width: 2008, height: 2854))
        XCTAssertEqual(brightBounds(viewer, threshold: 128), brightBounds(baseline, threshold: 128))
        XCTAssertEqual(letterboxer.cpuFrames, 0)
    }

    private func picture(width: Int, height: Int) throws -> CVPixelBuffer {
        var buffer: CVPixelBuffer?
        XCTAssertEqual(CVPixelBufferCreate(kCFAllocatorDefault, width, height, kCVPixelFormatType_32BGRA,
            [kCVPixelBufferIOSurfacePropertiesKey as String: [:]] as CFDictionary, &buffer), kCVReturnSuccess)
        let source = try XCTUnwrap(buffer)
        CVPixelBufferLockBaseAddress(source, [])
        defer { CVPixelBufferUnlockBaseAddress(source, []) }
        let bytes = try XCTUnwrap(CVPixelBufferGetBaseAddress(source)).assumingMemoryBound(to: UInt8.self)
        let stride = CVPixelBufferGetBytesPerRow(source)
        for y in 0..<height { for x in 0..<width {
            let offset = y * stride + x * 4
            bytes[offset] = 235; bytes[offset + 1] = 235; bytes[offset + 2] = 235; bytes[offset + 3] = 255
        }}
        return source
    }

    private func brightBounds(_ buffer: CVPixelBuffer, threshold: UInt8) -> RecordingContentRect {
        CVPixelBufferLockBaseAddress(buffer, .readOnly)
        defer { CVPixelBufferUnlockBaseAddress(buffer, .readOnly) }
        let bgra = CVPixelBufferGetPixelFormatType(buffer) == kCVPixelFormatType_32BGRA
        let bytes = (bgra ? CVPixelBufferGetBaseAddress(buffer) : CVPixelBufferGetBaseAddressOfPlane(buffer, 0))!
            .assumingMemoryBound(to: UInt8.self)
        let stride = bgra ? CVPixelBufferGetBytesPerRow(buffer) : CVPixelBufferGetBytesPerRowOfPlane(buffer, 0)
        let size = buffer.dimensions
        var left = size.width, top = size.height, right = -1, bottom = -1
        for y in 0..<size.height { for x in 0..<size.width where bytes[y * stride + x * (bgra ? 4 : 1)] > threshold {
            left = min(left, x); top = min(top, y); right = max(right, x); bottom = max(bottom, y)
        }}
        return .init(x: left, y: top, width: right - left + 1, height: bottom - top + 1)
    }
}
