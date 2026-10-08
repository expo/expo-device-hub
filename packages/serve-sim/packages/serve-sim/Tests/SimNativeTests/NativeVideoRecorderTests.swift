import AVFoundation
import CoreMedia
import CoreVideo
import Foundation
import XCTest
import VideoToolbox
@testable import SimNative
import StreamingPolicy

final class NativeVideoRecorderTests: XCTestCase {
    func testWriterFinalizationOutlivesEncoderFlushDeadlineAndRejectsDuplicateFinish() async throws {
        let (recorder, _, directory) = try await recordingForFinishTest()
        defer { try? FileManager.default.removeItem(at: directory) }
        let writing = expectation(description: "Writer finalization started")
        let release = DispatchSemaphore(value: 0)
        defer { release.signal() }
        let finishing = Task {
            try await recorder.finish(encoderFlushTimeout: 0.5,
                                      finishWriting: delayedWriter(writing, release: release))
        }
        await fulfillment(of: [writing], timeout: 2)
        do {
            _ = try await recorder.finish(encoderFlushTimeout: 0.05)
            XCTFail("A second finish must not interfere with the original")
        } catch {
            XCTAssertEqual((error as NSError).code, 12)
        }
        try await Task.sleep(for: .milliseconds(700))
        let mp4 = directory.appendingPathComponent("recording.mp4")
        XCTAssertTrue(FileManager.default.fileExists(atPath: mp4.path),
                      "A slow MP4 finalization must not cancel or delete the recording")
        XCTAssertFalse(FileManager.default.fileExists(
            atPath: directory.appendingPathComponent("session.json").path
        ))
        release.signal()
        let result = try await finishing.value
        XCTAssertGreaterThanOrEqual(result.finalizeMs, 700)
        XCTAssertTrue(FileManager.default.fileExists(atPath: result.manifestPath))
        let boxes = try topLevelMP4Boxes(at: mp4)
        XCTAssertLessThan(try XCTUnwrap(boxes["moov"]), try XCTUnwrap(boxes["mdat"]))
        let tracks = try await AVURLAsset(url: mp4).loadTracks(withMediaType: .video)
        XCTAssertFalse(tracks.isEmpty)
    }

    func testSlowWriterFinalizationPreservesEarlierFailureAndPartialMP4() async throws {
        let (recorder, mailbox, directory) = try await recordingForFinishTest()
        defer { try? FileManager.default.removeItem(at: directory) }
        var bad: CVPixelBuffer?
        XCTAssertEqual(CVPixelBufferCreate(kCFAllocatorDefault, 120, 240,
                                           kCVPixelFormatType_OneComponent8, nil, &bad), kCVReturnSuccess)
        mailbox.publish(try XCTUnwrap(bad), timestamp: CMTime(value: 1, timescale: 1), wallClock: Date())
        try await Task.sleep(for: .milliseconds(100))
        let writing = expectation(description: "Partial MP4 finalization started")
        let release = DispatchSemaphore(value: 0)
        defer { release.signal() }
        let finishing = Task {
            try await recorder.finish(encoderFlushTimeout: 0.5,
                                      finishWriting: delayedWriter(writing, release: release))
        }
        await fulfillment(of: [writing], timeout: 2)
        try await Task.sleep(for: .milliseconds(700))
        release.signal()
        let mp4 = directory.appendingPathComponent("recording.mp4")
        do {
            _ = try await finishing.value
            XCTFail("The original transfer failure must still be reported")
        } catch {
            let failure = error as NSError
            XCTAssertEqual(failure.code, 7)
            XCTAssertTrue(failure.localizedDescription.contains(mp4.path))
        }
        let tracks = try await AVURLAsset(url: mp4).loadTracks(withMediaType: .video)
        XCTAssertFalse(tracks.isEmpty)
        XCTAssertFalse(FileManager.default.fileExists(
            atPath: directory.appendingPathComponent("session.json").path
        ))
    }

    func testEncoderFlushStillTimesOutBeforeWriterFinalization() async throws {
        let (recorder, _, directory) = try await recordingForFinishTest()
        defer { try? FileManager.default.removeItem(at: directory) }
        let release = DispatchSemaphore(value: 0)
        defer { release.signal() }
        let flushed = expectation(description: "Late encoder flush returned")
        do {
            _ = try await recorder.finish(encoderFlushTimeout: 0.1, completeFrames: { session in
                release.wait()
                let status = VTCompressionSessionCompleteFrames(
                    session, untilPresentationTimeStamp: .invalid
                )
                flushed.fulfill()
                return status
            })
            XCTFail("A stalled encoder flush must time out")
        } catch {
            XCTAssertEqual((error as NSError).code, 15)
        }
        release.signal()
        await fulfillment(of: [flushed], timeout: 2)
        XCTAssertFalse(FileManager.default.fileExists(
            atPath: directory.appendingPathComponent("session.json").path
        ))
    }

    private func recordingForFinishTest() async throws -> (NativeVideoRecorder, NativeFrameMailbox, URL) {
        let directory = FileManager.default.temporaryDirectory
            .appendingPathComponent("serve-sim-recorder-finish-\(UUID().uuidString)")
        let mailbox = NativeFrameMailbox()
        mailbox.setActive(true)
        var frame: CVPixelBuffer?
        XCTAssertEqual(CVPixelBufferCreate(kCFAllocatorDefault, 120, 240,
                                           kCVPixelFormatType_32BGRA, nil, &frame), kCVReturnSuccess)
        mailbox.publish(try XCTUnwrap(frame), timestamp: .zero, wallClock: Date())
        let recorder = try NativeVideoRecorder(
            mailbox: mailbox, canvas: Dimensions(width: 320, height: 240),
            outputDirectory: directory.path, bitrate: 2_000_000
        )
        recorder.start()
        try await Task.sleep(for: .milliseconds(350))
        return (recorder, mailbox, directory)
    }

    private func delayedWriter(
        _ started: XCTestExpectation, release: DispatchSemaphore
    ) -> @Sendable (AVAssetWriter, @escaping @Sendable () -> Void) -> Void {
        { writer, completion in
            started.fulfill()
            DispatchQueue.global().async {
                release.wait()
                if writer.status == .writing {
                    writer.finishWriting(completionHandler: completion)
                } else {
                    completion()
                }
            }
        }
    }

    func testExistingManifestCannotBeReplacedAtStart() throws {
        let directory = FileManager.default.temporaryDirectory
            .appendingPathComponent("serve-sim-existing-manifest-\(UUID().uuidString)")
        defer { try? FileManager.default.removeItem(at: directory) }
        try FileManager.default.createDirectory(at: directory, withIntermediateDirectories: true)
        let manifest = directory.appendingPathComponent("session.json")
        let original = Data("existing session".utf8)
        try original.write(to: manifest)

        XCTAssertThrowsError(try NativeVideoRecorder(
            mailbox: NativeFrameMailbox(), canvas: Dimensions(width: 120, height: 240),
            outputDirectory: directory.path
        )) { error in
            XCTAssertEqual((error as NSError).code, 2)
        }
        XCTAssertEqual(try Data(contentsOf: manifest), original)
    }

    func testMissingSyncAttachmentsAreKeyframes() throws {
        var pixelBuffer: CVPixelBuffer?
        XCTAssertEqual(CVPixelBufferCreate(kCFAllocatorDefault, 16, 16,
                                           kCVPixelFormatType_32BGRA, nil, &pixelBuffer),
                       kCVReturnSuccess)
        let buffer = try XCTUnwrap(pixelBuffer)
        var format: CMVideoFormatDescription?
        XCTAssertEqual(CMVideoFormatDescriptionCreateForImageBuffer(
            allocator: kCFAllocatorDefault, imageBuffer: buffer, formatDescriptionOut: &format
        ), noErr)
        var timing = CMSampleTimingInfo(duration: .invalid,
                                        presentationTimeStamp: .zero,
                                        decodeTimeStamp: .invalid)
        var sample: CMSampleBuffer?
        XCTAssertEqual(CMSampleBufferCreateReadyWithImageBuffer(
            allocator: kCFAllocatorDefault, imageBuffer: buffer,
            formatDescription: try XCTUnwrap(format), sampleTiming: &timing,
            sampleBufferOut: &sample
        ), noErr)
        let frame = try XCTUnwrap(sample)
        XCTAssertTrue(NativeVideoRecorder.isKeyframe(frame))
        let attachments = try XCTUnwrap(CMSampleBufferGetSampleAttachmentsArray(
            frame, createIfNecessary: true
        ))
        let values = try XCTUnwrap(CFArrayGetValueAtIndex(attachments, 0))
        let dictionary = unsafeBitCast(values, to: CFMutableDictionary.self)
        CFDictionarySetValue(dictionary,
                             Unmanaged.passUnretained(kCMSampleAttachmentKey_NotSync).toOpaque(),
                             Unmanaged.passUnretained(kCFBooleanTrue).toOpaque())
        XCTAssertFalse(NativeVideoRecorder.isKeyframe(frame))
    }
    func testHardwareRecordingRepeatsOwnedFrameAndWritesNativeCanvas() async throws {
        let directory = FileManager.default.temporaryDirectory
            .appendingPathComponent("serve-sim-recorder-\(UUID().uuidString)")
        defer { try? FileManager.default.removeItem(at: directory) }
        let mailbox = NativeFrameMailbox()
        mailbox.setActive(true)
        var frame: CVPixelBuffer?
        let attributes: [String: Any] = [
            kCVPixelBufferPixelFormatTypeKey as String: kCVPixelFormatType_420YpCbCr8BiPlanarVideoRange,
            kCVPixelBufferWidthKey as String: 120,
            kCVPixelBufferHeightKey as String: 240,
            kCVPixelBufferIOSurfacePropertiesKey as String: [:],
        ]
        XCTAssertEqual(CVPixelBufferCreate(kCFAllocatorDefault, 120, 240,
                                           kCVPixelFormatType_420YpCbCr8BiPlanarVideoRange,
                                           attributes as CFDictionary, &frame), kCVReturnSuccess)
        let owned = try XCTUnwrap(frame)
        CVPixelBufferLockBaseAddress(owned, [])
        memset(CVPixelBufferGetBaseAddressOfPlane(owned, 0), 235,
               CVPixelBufferGetBytesPerRowOfPlane(owned, 0) * CVPixelBufferGetHeightOfPlane(owned, 0))
        memset(CVPixelBufferGetBaseAddressOfPlane(owned, 1), 128,
               CVPixelBufferGetBytesPerRowOfPlane(owned, 1) * CVPixelBufferGetHeightOfPlane(owned, 1))
        CVPixelBufferUnlockBaseAddress(owned, [])
        mailbox.publish(owned, timestamp: CMTime(value: 1, timescale: 60), wallClock: Date())

        let recorder = try NativeVideoRecorder(
            mailbox: mailbox, canvas: Dimensions(width: 321, height: 241),
            outputDirectory: directory.path, bitrate: 2_000_000
        )
        recorder.start()
        try await Task.sleep(for: .seconds(1))
        let result = try await recorder.finish()

        XCTAssertGreaterThan(result.encodedFrames, 20)
        XCTAssertGreaterThan(result.writtenFrames, 20)
        XCTAssertGreaterThan(result.repeatedFrames, 20)
        XCTAssertLessThan(result.droppedTicks, 20)
        XCTAssertEqual(result.writerDrops, 0)
        XCTAssertEqual(result.writerBackpressureTicks, 0)
        XCTAssertEqual(result.encodeFailures, 0)
        XCTAssertLessThanOrEqual(result.maxInFlight, 16)
        XCTAssertGreaterThan(result.meanEncodeMs, 0)
        XCTAssertGreaterThanOrEqual(result.maxEncodeMs, result.meanEncodeMs)
        XCTAssertFalse(result.encoderID.isEmpty)

        let manifest = try JSONDecoder().decode(
            RecordingManifest.self,
            from: Data(contentsOf: URL(fileURLWithPath: result.manifestPath))
        )
        XCTAssertEqual(manifest.width, 322)
        XCTAssertEqual(manifest.height, 242)
        XCTAssertEqual(manifest.recording, "recording.mp4")
        let recordingURL = directory.appendingPathComponent("recording.mp4")
        let boxes = try topLevelMP4Boxes(at: recordingURL)
        XCTAssertLessThan(try XCTUnwrap(boxes["moov"]), try XCTUnwrap(boxes["mdat"]),
                          "The MP4 index must precede media data for progressive playback")
        let asset = AVURLAsset(url: recordingURL)
        let tracks = try await asset.loadTracks(withMediaType: .video)
        let track = try XCTUnwrap(tracks.first)
        let size = try await track.load(.naturalSize)
        let frameRate = try await track.load(.nominalFrameRate)
        let duration = try await asset.load(.duration)
        XCTAssertEqual(Int(size.width), 322)
        XCTAssertEqual(Int(size.height), 242)
        XCTAssertGreaterThan(frameRate, 45)
        XCTAssertLessThanOrEqual(frameRate, 60)
        XCTAssertGreaterThan(duration.seconds, 0.4)
    }

    private func topLevelMP4Boxes(at url: URL) throws -> [String: Int] {
        let data = try Data(contentsOf: url)
        var boxes: [String: Int] = [:]
        var offset = 0
        while offset < data.count {
            let remaining = data.count - offset
            guard remaining >= 8 else { throw NSError(domain: "MP4BoxTest", code: 1) }
            var size = data[offset..<(offset + 4)].reduce(UInt64(0)) { ($0 << 8) | UInt64($1) }
            let type = String(decoding: data[(offset + 4)..<(offset + 8)], as: UTF8.self)
            let headerSize: UInt64 = size == 1 ? 16 : 8
            if size == 1 {
                guard remaining >= 16 else { throw NSError(domain: "MP4BoxTest", code: 2) }
                size = data[(offset + 8)..<(offset + 16)].reduce(UInt64(0)) { ($0 << 8) | UInt64($1) }
            } else if size == 0 {
                size = UInt64(remaining)
            }
            guard size >= headerSize, size <= UInt64(remaining) else {
                throw NSError(domain: "MP4BoxTest", code: 3)
            }
            boxes[type] = boxes[type] ?? offset
            offset += Int(size)
        }
        return boxes
    }

    func testManifestFailurePreservesMP4ForRecovery() async throws {
        let directory = FileManager.default.temporaryDirectory
            .appendingPathComponent("serve-sim-recorder-manifest-\(UUID().uuidString)")
        defer { try? FileManager.default.removeItem(at: directory) }
        let mailbox = NativeFrameMailbox()
        mailbox.setActive(true)
        var frame: CVPixelBuffer?
        XCTAssertEqual(CVPixelBufferCreate(kCFAllocatorDefault, 120, 240,
                                           kCVPixelFormatType_32BGRA, nil, &frame),
                       kCVReturnSuccess)
        mailbox.publish(try XCTUnwrap(frame), timestamp: .zero, wallClock: Date())
        let recorder = try NativeVideoRecorder(
            mailbox: mailbox, canvas: Dimensions(width: 120, height: 240),
            outputDirectory: directory.path, bitrate: 2_000_000
        )
        recorder.start()
        try await Task.sleep(for: .milliseconds(250))
        try FileManager.default.createDirectory(
            at: directory.appendingPathComponent("session.json"),
            withIntermediateDirectories: true
        )
        do {
            _ = try await recorder.finish()
            XCTFail("A manifest write failure must fail recording finalization")
        } catch {
            let failure = error as NSError
            XCTAssertEqual(failure.domain, "serve-sim-recording")
            XCTAssertEqual(failure.code, 17)
            XCTAssertTrue(FileManager.default.fileExists(
                atPath: directory.appendingPathComponent("recording.mp4").path
            ))
        }
    }

    func testNoSourceFrameFailsInsteadOfWritingAnEmptyManifest() async throws {
        let directory = FileManager.default.temporaryDirectory
            .appendingPathComponent("serve-sim-recorder-empty-\(UUID().uuidString)")
        defer { try? FileManager.default.removeItem(at: directory) }
        let recorder = try NativeVideoRecorder(
            mailbox: NativeFrameMailbox(), canvas: Dimensions(width: 320, height: 240),
            outputDirectory: directory.path, bitrate: 2_000_000
        )
        recorder.start()
        try await Task.sleep(for: .milliseconds(100))
        do {
            _ = try await recorder.finish()
            XCTFail("An empty recording must fail")
        } catch {
            XCTAssertFalse(FileManager.default.fileExists(
                atPath: directory.appendingPathComponent("session.json").path
            ))
        }
    }

    func testUntransferableFrameFailsRecordingWithoutManifest() async throws {
        let directory = FileManager.default.temporaryDirectory
            .appendingPathComponent("serve-sim-recorder-transfer-\(UUID().uuidString)")
        defer { try? FileManager.default.removeItem(at: directory) }
        let mailbox = NativeFrameMailbox()
        mailbox.setActive(true)
        var frame: CVPixelBuffer?
        XCTAssertEqual(CVPixelBufferCreate(kCFAllocatorDefault, 120, 240,
                                           kCVPixelFormatType_OneComponent8, nil, &frame),
                       kCVReturnSuccess)
        mailbox.publish(try XCTUnwrap(frame), timestamp: .zero, wallClock: Date())
        let recorder = try NativeVideoRecorder(
            mailbox: mailbox, canvas: Dimensions(width: 320, height: 240),
            outputDirectory: directory.path, bitrate: 2_000_000
        )
        recorder.start()
        try await Task.sleep(for: .milliseconds(100))
        do {
            _ = try await recorder.finish()
            XCTFail("An untransferable frame must fail recording finalization")
        } catch {
            let failure = error as NSError
            XCTAssertEqual(failure.domain, "serve-sim-recording")
            XCTAssertEqual(failure.code, 7)
            XCTAssertFalse(FileManager.default.fileExists(
                atPath: directory.appendingPathComponent("session.json").path
            ))
        }
    }

    func testTransferFailureKeepsPlayableFramesAlreadyWritten() async throws {
        let directory = FileManager.default.temporaryDirectory
            .appendingPathComponent("serve-sim-recorder-partial-\(UUID().uuidString)")
        defer { try? FileManager.default.removeItem(at: directory) }
        let mailbox = NativeFrameMailbox()
        mailbox.setActive(true)
        var good: CVPixelBuffer?
        XCTAssertEqual(CVPixelBufferCreate(kCFAllocatorDefault, 120, 240,
                                           kCVPixelFormatType_32BGRA, nil, &good), kCVReturnSuccess)
        mailbox.publish(try XCTUnwrap(good), timestamp: .zero, wallClock: Date())
        let recorder = try NativeVideoRecorder(
            mailbox: mailbox, canvas: Dimensions(width: 320, height: 240),
            outputDirectory: directory.path, bitrate: 2_000_000
        )
        recorder.start()
        try await Task.sleep(for: .milliseconds(350))
        var bad: CVPixelBuffer?
        XCTAssertEqual(CVPixelBufferCreate(kCFAllocatorDefault, 120, 240,
                                           kCVPixelFormatType_OneComponent8, nil, &bad), kCVReturnSuccess)
        mailbox.publish(try XCTUnwrap(bad), timestamp: CMTime(value: 1, timescale: 1), wallClock: Date())
        try await Task.sleep(for: .milliseconds(100))
        do {
            _ = try await recorder.finish()
            XCTFail("A transfer failure must still be reported")
        } catch {
            let failure = error as NSError
            XCTAssertEqual(failure.domain, "serve-sim-recording")
            XCTAssertEqual(failure.code, 7)
            let mp4 = directory.appendingPathComponent("recording.mp4")
            XCTAssertTrue(failure.localizedDescription.contains(mp4.path))
            let tracks = try await AVURLAsset(url: mp4).loadTracks(withMediaType: .video)
            XCTAssertFalse(tracks.isEmpty)
        }
        XCTAssertFalse(FileManager.default.fileExists(
            atPath: directory.appendingPathComponent("session.json").path
        ))
    }
}
