import CoreMedia
import CoreVideo
import XCTest
@testable import SimNative

final class NativeFrameHistoryTests: XCTestCase {
    private let interval: UInt64 = 16_666_667

    func testRecordingKeepsUniquePicturesInArrivalOrderInsteadOfReplacingTheMiddle() {
        let mailbox = recordingMailbox()
        let first = buffer(value: 1)
        let second = buffer(value: 2)
        let third = buffer(value: 3)
        publish(first, to: mailbox, number: 1, at: 0)
        publish(second, to: mailbox, number: 2, at: interval)
        publish(third, to: mailbox, number: 3, at: interval * 2)

        XCTAssertTrue(mailbox.latest()?.pixelBuffer === third)
        XCTAssertTrue(mailbox.nextForRecording(atNanoseconds: interval * 2)?.pixelBuffer === first)
        XCTAssertTrue(mailbox.nextForRecording(atNanoseconds: interval * 3)?.pixelBuffer === second)
        XCTAssertTrue(mailbox.nextForRecording(atNanoseconds: interval * 4)?.pixelBuffer === third)
        XCTAssertTrue(mailbox.nextForRecording(atNanoseconds: interval * 5)?.pixelBuffer === third)
    }

    func testIdenticalCopiesKeepFirstContentTimestampButLatestStillReturnsNewestCopy() {
        let mailbox = recordingMailbox()
        let first = buffer(value: 7)
        publish(first, to: mailbox, number: 1, at: 0)
        _ = mailbox.nextForRecording(atNanoseconds: 0)
        for number in 2...12 {
            let copy = buffer(value: 7)
            publish(copy, to: mailbox, number: number, at: UInt64(number) * interval)
            XCTAssertTrue(mailbox.latest()?.pixelBuffer === copy)
        }

        let repeated = mailbox.nextForRecording(atNanoseconds: 10_000_000_000)
        XCTAssertTrue(repeated?.pixelBuffer === first)
        XCTAssertEqual(repeated?.timestamp, CMTime(value: 1, timescale: 60))
        XCTAssertEqual(mailbox.historyStats.duplicateFrames, 11)
        XCTAssertEqual(mailbox.historyStats.comparisons, 11)
        XCTAssertEqual(mailbox.historyStats.pendingFrames, 0)
        XCTAssertLessThanOrEqual(mailbox.historyStats.maxRetainedFrames, 4)
    }

    func testFinishingChoosesNewestPictureAndDiscardsPendingOlderPictures() {
        let mailbox = recordingMailbox()
        let first = buffer(value: 1)
        let second = buffer(value: 2)
        let newest = buffer(value: 3)
        publish(first, to: mailbox, number: 1, at: 0)
        publish(second, to: mailbox, number: 2, at: interval)
        publish(newest, to: mailbox, number: 3, at: interval * 2)

        let final = mailbox.nextForRecording(atNanoseconds: interval * 2, finishing: true)
        XCTAssertTrue(final?.pixelBuffer === newest)
        XCTAssertEqual(final?.timestamp, CMTime(value: 3, timescale: 60))
        XCTAssertEqual(mailbox.historyStats.pendingFrames, 0)
        XCTAssertEqual(mailbox.historyStats.finalizationDrops, 2)
        XCTAssertEqual(mailbox.historyStats.staleDrops, 0)
        XCTAssertEqual(mailbox.historyStats.overloadDrops, 0)
        XCTAssertTrue(mailbox.nextForRecording(atNanoseconds: interval * 3, finishing: true)?.pixelBuffer === newest)
        XCTAssertEqual(mailbox.historyStats.finalizationDrops, 2)
    }

    func testOverloadDropsOldestAndRetainsAtMostThreePendingPictures() {
        let mailbox = recordingMailbox()
        for number in 1...7 {
            publish(buffer(value: UInt8(number)), to: mailbox, number: number, at: 0)
            XCTAssertLessThanOrEqual(mailbox.historyStats.pendingFrames, 3)
        }
        let timestamps = (0..<3).compactMap { _ in
            mailbox.nextForRecording(atNanoseconds: 0)?.timestamp.value
        }
        XCTAssertEqual(timestamps, [5, 6, 7])
        XCTAssertEqual(mailbox.historyStats.overloadDrops, 4)
        XCTAssertLessThanOrEqual(mailbox.historyStats.maxRetainedFrames, 4)
    }

    func testLongConsumerStallDiscardsOldStatesAndKeepsNewestStaticPicture() {
        let mailbox = recordingMailbox()
        for number in 1...4 {
            publish(buffer(value: UInt8(number)), to: mailbox, number: number,
                    at: UInt64(number) * interval)
        }
        let resumed = mailbox.nextForRecording(atNanoseconds: 10_000_000_000)
        XCTAssertEqual(resumed?.timestamp.value, 4)
        XCTAssertEqual(mailbox.historyStats.staleDrops, 2)
        XCTAssertEqual(mailbox.historyStats.overloadDrops, 1)
        XCTAssertEqual(mailbox.nextForRecording(atNanoseconds: 20_000_000_000)?.timestamp.value, 4)
        publish(buffer(value: 5), to: mailbox, number: 5, at: 20_000_000_000)
        XCTAssertEqual(mailbox.nextForRecording(atNanoseconds: 20_000_000_000)?.timestamp.value, 5)
    }

    func testHistoryExpiresAtFourIntervalsWithoutDroppingNewestPicture() {
        let mailbox = recordingMailbox()
        publish(buffer(value: 1), to: mailbox, number: 1, at: 0)
        publish(buffer(value: 2), to: mailbox, number: 2, at: interval)
        XCTAssertEqual(mailbox.nextForRecording(atNanoseconds: interval * 4)?.timestamp.value, 1)
        publish(buffer(value: 3), to: mailbox, number: 3, at: interval * 4)
        XCTAssertEqual(mailbox.nextForRecording(atNanoseconds: interval * 5 + 1)?.timestamp.value, 3)
        XCTAssertEqual(mailbox.historyStats.staleDrops, 1)
    }

    func testHistoryIsRecordingOnlyAndClearResetsCanonicalFrame() {
        let mailbox = NativeFrameMailbox()
        mailbox.setActive(true)
        publish(buffer(value: 4), to: mailbox, number: 1, at: 0)
        publish(buffer(value: 4), to: mailbox, number: 2, at: interval)
        XCTAssertEqual(mailbox.historyStats.comparisons, 0)
        XCTAssertNil(mailbox.nextForRecording(atNanoseconds: interval))

        _ = mailbox.beginRecording(atNanoseconds: interval)
        XCTAssertEqual(mailbox.nextForRecording(atNanoseconds: interval)?.timestamp.value, 2)
        mailbox.setActive(false)
        XCTAssertNil(mailbox.latest())
        XCTAssertNil(mailbox.nextForRecording(atNanoseconds: interval))
        mailbox.setActive(true)
        _ = mailbox.beginRecording(atNanoseconds: interval * 2)
        publish(buffer(value: 4), to: mailbox, number: 3, at: interval * 2)
        XCTAssertEqual(mailbox.nextForRecording(atNanoseconds: interval * 2)?.timestamp.value, 3)
        XCTAssertEqual(mailbox.historyStats.duplicateFrames, 0)
    }

    func testBGRAPaddingDoesNotCreateANewPictureButAnActiveByteDoes() {
        let mailbox = recordingMailbox()
        let first = buffer(value: 7, padding: 20)
        let paddedCopy = buffer(value: 7, padding: 200, alignment: 128)
        let changed = buffer(value: 8, padding: 20)
        XCTAssertGreaterThan(CVPixelBufferGetBytesPerRow(first), CVPixelBufferGetWidth(first) * 4)
        XCTAssertNotEqual(CVPixelBufferGetBytesPerRow(first), CVPixelBufferGetBytesPerRow(paddedCopy))
        publish(first, to: mailbox, number: 1, at: 0)
        publish(paddedCopy, to: mailbox, number: 2, at: 0)
        publish(changed, to: mailbox, number: 3, at: 0)
        XCTAssertEqual(mailbox.historyStats.duplicateFrames, 1)
        XCTAssertEqual(mailbox.nextForRecording(atNanoseconds: 0)?.timestamp.value, 1)
        XCTAssertEqual(mailbox.nextForRecording(atNanoseconds: 0)?.timestamp.value, 3)
    }

    func testNV12ComparisonIncludesChromaAndIgnoresStridePadding() {
        let mailbox = recordingMailbox()
        let first = buffer(value: 40, padding: 10, planar: true)
        let paddedCopy = buffer(value: 40, padding: 220, planar: true, alignment: 128)
        let chromaChanged = buffer(value: 40, padding: 10, planar: true)
        CVPixelBufferLockBaseAddress(chromaChanged, [])
        let uv = CVPixelBufferGetBaseAddressOfPlane(chromaChanged, 1)!.assumingMemoryBound(to: UInt8.self)
        uv[CVPixelBufferGetWidthOfPlane(chromaChanged, 1) * 2 - 1] = 129
        CVPixelBufferUnlockBaseAddress(chromaChanged, [])
        XCTAssertNotEqual(CVPixelBufferGetBytesPerRowOfPlane(first, 0),
                          CVPixelBufferGetBytesPerRowOfPlane(paddedCopy, 0))
        publish(first, to: mailbox, number: 1, at: 0)
        publish(paddedCopy, to: mailbox, number: 2, at: 0)
        publish(chromaChanged, to: mailbox, number: 3, at: 0)
        XCTAssertEqual(mailbox.historyStats.duplicateFrames, 1)
        XCTAssertEqual(mailbox.nextForRecording(atNanoseconds: 0)?.timestamp.value, 1)
        XCTAssertEqual(mailbox.nextForRecording(atNanoseconds: 0)?.timestamp.value, 3)
    }

    func testOldRecordingCannotClearALaterRecording() {
        let mailbox = NativeFrameMailbox()
        mailbox.setActive(true)
        let firstGeneration = mailbox.beginRecording(atNanoseconds: 0)!
        publish(buffer(value: 1), to: mailbox, number: 1, at: 0)
        mailbox.endRecording(generation: firstGeneration)
        XCTAssertNotNil(mailbox.latest())
        let secondGeneration = mailbox.beginRecording(atNanoseconds: interval)!
        XCTAssertNotEqual(firstGeneration, secondGeneration)
        mailbox.endRecording(generation: firstGeneration)
        XCTAssertEqual(mailbox.nextForRecording(atNanoseconds: interval)?.timestamp.value, 1)
    }

    func testRecordingResumesAfterAPauseWithoutKeepingPrePausePictures() {
        let mailbox = NativeFrameMailbox()
        mailbox.setActive(true)
        let generation = mailbox.beginRecording(atNanoseconds: 0)!
        publish(buffer(value: 7), to: mailbox, number: 1, at: 0)
        publish(buffer(value: 8), to: mailbox, number: 2, at: interval)

        mailbox.setActive(false)
        XCTAssertNil(mailbox.latest())
        XCTAssertNil(mailbox.nextForRecording(atNanoseconds: interval * 2))
        XCTAssertEqual(mailbox.historyStats.pendingFrames, 0)
        publish(buffer(value: 9), to: mailbox, number: 3, at: interval * 2)
        XCTAssertNil(mailbox.latest())

        mailbox.setActive(true)
        XCTAssertNil(mailbox.beginRecording(atNanoseconds: interval * 3),
                     "A pause must preserve the active recording's ownership")
        publish(buffer(value: 8), to: mailbox, number: 4, at: interval * 3)
        XCTAssertEqual(mailbox.nextForRecording(atNanoseconds: interval * 3)?.timestamp.value, 4)
        XCTAssertEqual(mailbox.historyStats.duplicateFrames, 0,
                       "Identical pre-pause pixels must not hide the resumed picture")
        mailbox.endRecording(generation: generation)
        XCTAssertNil(mailbox.nextForRecording(atNanoseconds: interval * 4))
    }

    func testRecordingCanEndWhilePausedWithoutClearingALaterRecording() {
        let mailbox = NativeFrameMailbox()
        mailbox.setActive(true)
        let firstGeneration = mailbox.beginRecording(atNanoseconds: 0)!
        publish(buffer(value: 1), to: mailbox, number: 1, at: 0)
        mailbox.setActive(false)
        mailbox.endRecording(generation: firstGeneration)
        mailbox.setActive(true)

        let secondGeneration = mailbox.beginRecording(atNanoseconds: interval)!
        XCTAssertNotEqual(firstGeneration, secondGeneration)
        publish(buffer(value: 2), to: mailbox, number: 2, at: interval)
        mailbox.endRecording(generation: firstGeneration)
        XCTAssertEqual(mailbox.nextForRecording(atNanoseconds: interval)?.timestamp.value, 2)
        mailbox.endRecording(generation: secondGeneration)
        XCTAssertNil(mailbox.nextForRecording(atNanoseconds: interval * 2))
    }

    func testChangedColorAttachmentsAreANewPicture() {
        let mailbox = recordingMailbox()
        let first = buffer(value: 40, planar: true)
        let changed = buffer(value: 40, planar: true)
        CVBufferSetAttachment(first, kCVImageBufferColorPrimariesKey,
                              kCVImageBufferColorPrimaries_ITU_R_709_2, .shouldPropagate)
        CVBufferSetAttachment(changed, kCVImageBufferColorPrimariesKey,
                              kCVImageBufferColorPrimaries_ITU_R_2020, .shouldPropagate)
        publish(first, to: mailbox, number: 1, at: 0)
        publish(changed, to: mailbox, number: 2, at: 0)
        XCTAssertEqual(mailbox.historyStats.duplicateFrames, 0)
        XCTAssertEqual(mailbox.nextForRecording(atNanoseconds: 0)?.timestamp.value, 1)
        XCTAssertEqual(mailbox.nextForRecording(atNanoseconds: 0)?.timestamp.value, 2)
    }

    private func recordingMailbox() -> NativeFrameMailbox {
        let mailbox = NativeFrameMailbox()
        mailbox.setActive(true)
        _ = mailbox.beginRecording(atNanoseconds: 0)
        return mailbox
    }

    private func publish(_ buffer: CVPixelBuffer, to mailbox: NativeFrameMailbox,
                         number: Int, at now: UInt64) {
        mailbox.publish(buffer, timestamp: CMTime(value: Int64(number), timescale: 60),
                        wallClock: Date(timeIntervalSince1970: Double(number)), atNanoseconds: now)
    }

    private func buffer(value: UInt8, padding: UInt8 = 0, planar: Bool = false,
                        alignment: Int = 64) -> CVPixelBuffer {
        let format = planar ? kCVPixelFormatType_420YpCbCr8BiPlanarVideoRange : kCVPixelFormatType_32BGRA
        let attributes: [String: Any] = [
            kCVPixelBufferBytesPerRowAlignmentKey as String: alignment,
            kCVPixelBufferIOSurfacePropertiesKey as String: [:],
        ]
        var result: CVPixelBuffer?
        XCTAssertEqual(CVPixelBufferCreate(kCFAllocatorDefault, 10, 8, format,
                                           attributes as CFDictionary, &result), kCVReturnSuccess)
        let buffer = result!
        CVPixelBufferLockBaseAddress(buffer, [])
        defer { CVPixelBufferUnlockBaseAddress(buffer, []) }
        for plane in 0..<(planar ? 2 : 1) {
            let base = planar ? CVPixelBufferGetBaseAddressOfPlane(buffer, plane)! : CVPixelBufferGetBaseAddress(buffer)!
            let stride = planar ? CVPixelBufferGetBytesPerRowOfPlane(buffer, plane) : CVPixelBufferGetBytesPerRow(buffer)
            let rows = planar ? CVPixelBufferGetHeightOfPlane(buffer, plane) : CVPixelBufferGetHeight(buffer)
            let rowBytes = planar ? CVPixelBufferGetWidthOfPlane(buffer, plane) * (plane == 0 ? 1 : 2) : CVPixelBufferGetWidth(buffer) * 4
            memset(base, Int32(padding), stride * rows)
            for row in 0..<rows { memset(base + row * stride, plane == 1 ? 128 : Int32(value), rowBytes) }
        }
        return buffer
    }
}
