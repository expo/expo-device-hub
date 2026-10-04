import AVFoundation
import CoreMedia
import CoreVideo
import Foundation
import XCTest
@testable import SimNative
import StreamingPolicy

final class NativeVideoRecorderTests: XCTestCase {
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

    func testImmediateFinishProducesPlayableRecordingStartingWithAKeyframe() async throws {
        let directory = FileManager.default.temporaryDirectory
            .appendingPathComponent("serve-sim-recorder-immediate-finish-\(UUID().uuidString)")
        defer { try? FileManager.default.removeItem(at: directory) }
        let mailbox = NativeFrameMailbox()
        mailbox.setActive(true)
        var frame: CVPixelBuffer?
        let attributes: [String: Any] = [
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
        mailbox.publish(owned, timestamp: .zero, wallClock: Date())

        let recorder: NativeVideoRecorder
        do {
            recorder = try NativeVideoRecorder(
                mailbox: mailbox, canvas: Dimensions(width: 120, height: 240),
                outputDirectory: directory.path, bitrate: 2_000_000
            )
        } catch {
            let failure = error as NSError
            if failure.domain == "serve-sim-recording", [3, 6].contains(failure.code) {
                throw XCTSkip("Hardware H.264 recording is unavailable: \(failure.localizedDescription)")
            }
            throw error
        }
        recorder.start()
        let result = try await recorder.finish()

        XCTAssertGreaterThan(result.encodedFrames, 0)
        XCTAssertEqual(result.writtenFrames, result.encodedFrames)
        XCTAssertEqual(result.encodeFailures, 0)
        XCTAssertEqual(result.writerDrops, 0)
        let manifest = try JSONDecoder().decode(
            RecordingManifest.self, from: Data(contentsOf: URL(fileURLWithPath: result.manifestPath))
        )
        XCTAssertEqual(manifest.width, 120)
        XCTAssertEqual(manifest.height, 240)
        let asset = AVURLAsset(url: directory.appendingPathComponent("recording.mp4"))
        let tracks = try await asset.loadTracks(withMediaType: .video)
        let track = try XCTUnwrap(tracks.first)
        let duration = try await asset.load(.duration)
        XCTAssertGreaterThanOrEqual(duration.seconds + 0.00001, Double(result.writtenFrames) / 60)

        let encodedReader = try AVAssetReader(asset: asset)
        let encodedOutput = AVAssetReaderTrackOutput(track: track, outputSettings: nil)
        encodedReader.add(encodedOutput)
        XCTAssertTrue(encodedReader.startReading(), encodedReader.error?.localizedDescription ?? "Could not read keyframe")
        var encodedSamples: UInt64 = 0
        while let sample = encodedOutput.copyNextSampleBuffer() {
            // Compressed reads can include zero-sample edit-boundary buffers.
            let count = CMSampleBufferGetNumSamples(sample)
            guard count > 0 else { continue }
            if encodedSamples == 0 {
                XCTAssertTrue(NativeVideoRecorder.isKeyframe(sample))
                XCTAssertEqual(CMSampleBufferGetPresentationTimeStamp(sample), .zero)
            }
            encodedSamples += UInt64(count)
        }
        XCTAssertEqual(encodedSamples, result.writtenFrames)
        XCTAssertEqual(encodedReader.status, .completed)

        let decodedReader = try AVAssetReader(asset: asset)
        let decodedOutput = AVAssetReaderTrackOutput(track: track, outputSettings: [
            kCVPixelBufferPixelFormatTypeKey as String: kCVPixelFormatType_420YpCbCr8BiPlanarVideoRange,
        ])
        decodedReader.add(decodedOutput)
        XCTAssertTrue(decodedReader.startReading(), decodedReader.error?.localizedDescription ?? "Could not decode keyframe")
        var decodedSamples: UInt64 = 0
        while let decoded = decodedOutput.copyNextSampleBuffer() {
            let pixels = try XCTUnwrap(CMSampleBufferGetImageBuffer(decoded))
            XCTAssertEqual(CVPixelBufferGetWidth(pixels), 120)
            XCTAssertEqual(CVPixelBufferGetHeight(pixels), 240)
            CVPixelBufferLockBaseAddress(pixels, .readOnly)
            let luma = CVPixelBufferGetBaseAddressOfPlane(pixels, 0)!.assumingMemoryBound(to: UInt8.self)
            XCTAssertGreaterThan(luma[0], 230)
            CVPixelBufferUnlockBaseAddress(pixels, .readOnly)
            decodedSamples += 1
        }
        XCTAssertEqual(decodedSamples, result.writtenFrames)
        XCTAssertEqual(decodedReader.status, .completed)
    }

    func testFinishWritesNewestCapturedPictureAsTheDecodedFinalFrame() async throws {
        let directory = FileManager.default.temporaryDirectory
            .appendingPathComponent("serve-sim-recorder-final-frame-\(UUID().uuidString)")
        defer { try? FileManager.default.removeItem(at: directory) }
        let mailbox = NativeFrameMailbox()
        mailbox.setActive(true)
        let first = try solidNV12Frame(luma: 16)
        let middle = try solidNV12Frame(luma: 80)
        let newest = try solidNV12Frame(luma: 235)
        mailbox.publish(first, timestamp: .zero, wallClock: Date())

        let recorder: NativeVideoRecorder
        do {
            recorder = try NativeVideoRecorder(
                mailbox: mailbox, canvas: Dimensions(width: 120, height: 240),
                outputDirectory: directory.path, bitrate: 2_000_000
            )
        } catch {
            let failure = error as NSError
            if failure.domain == "serve-sim-recording", [3, 6].contains(failure.code) {
                throw XCTSkip("Hardware H.264 recording is unavailable: \(failure.localizedDescription)")
            }
            throw error
        }
        recorder.start()
        let deadline = ContinuousClock.now + .seconds(2)
        while mailbox.historyStats.maxRetainedFrames == 0, ContinuousClock.now < deadline {
            await Task.yield()
        }
        XCTAssertGreaterThan(mailbox.historyStats.maxRetainedFrames, 0)
        mailbox.publish(middle, timestamp: CMTime(value: 1, timescale: 60), wallClock: Date())
        mailbox.publish(newest, timestamp: CMTime(value: 2, timescale: 60), wallClock: Date())
        let result = try await recorder.finish()
        XCTAssertGreaterThan(result.writtenFrames, 0)
        XCTAssertEqual(result.encodeFailures, 0)

        let asset = AVURLAsset(url: directory.appendingPathComponent("recording.mp4"))
        let tracks = try await asset.loadTracks(withMediaType: .video)
        let reader = try AVAssetReader(asset: asset)
        let output = AVAssetReaderTrackOutput(track: try XCTUnwrap(tracks.first), outputSettings: [
            kCVPixelBufferPixelFormatTypeKey as String: kCVPixelFormatType_420YpCbCr8BiPlanarVideoRange,
        ])
        reader.add(output)
        XCTAssertTrue(reader.startReading(), reader.error?.localizedDescription ?? "Could not decode final frame")
        var finalLuma: UInt8?
        while let sample = output.copyNextSampleBuffer() {
            let pixels = try XCTUnwrap(CMSampleBufferGetImageBuffer(sample))
            CVPixelBufferLockBaseAddress(pixels, .readOnly)
            let luma = CVPixelBufferGetBaseAddressOfPlane(pixels, 0)!.assumingMemoryBound(to: UInt8.self)
            finalLuma = luma[120 * CVPixelBufferGetBytesPerRowOfPlane(pixels, 0) + 60]
            CVPixelBufferUnlockBaseAddress(pixels, .readOnly)
        }
        XCTAssertEqual(reader.status, .completed)
        XCTAssertGreaterThan(try XCTUnwrap(finalLuma), 230)
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

    private func solidNV12Frame(luma: UInt8) throws -> CVPixelBuffer {
        var frame: CVPixelBuffer?
        let attributes = [kCVPixelBufferIOSurfacePropertiesKey as String: [:]] as CFDictionary
        XCTAssertEqual(CVPixelBufferCreate(kCFAllocatorDefault, 120, 240,
                                           kCVPixelFormatType_420YpCbCr8BiPlanarVideoRange,
                                           attributes, &frame), kCVReturnSuccess)
        let owned = try XCTUnwrap(frame)
        CVPixelBufferLockBaseAddress(owned, [])
        defer { CVPixelBufferUnlockBaseAddress(owned, []) }
        memset(CVPixelBufferGetBaseAddressOfPlane(owned, 0), Int32(luma),
               CVPixelBufferGetBytesPerRowOfPlane(owned, 0) * CVPixelBufferGetHeightOfPlane(owned, 0))
        memset(CVPixelBufferGetBaseAddressOfPlane(owned, 1), 128,
               CVPixelBufferGetBytesPerRowOfPlane(owned, 1) * CVPixelBufferGetHeightOfPlane(owned, 1))
        return owned
    }
}
