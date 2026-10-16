import AVFoundation
import CoreMedia
import CoreVideo
import Foundation
import XCTest
import VideoToolbox
@testable import SimNative
import StreamingPolicy

final class NativeVideoRecorderTests: XCTestCase {
    func testFinalizingDuringRebootPreservesTheOriginalFootageAndUnresumedInterruption() async throws {
        let (recorder, mailbox, directory) = try await recordingForFinishTest()
        defer { try? FileManager.default.removeItem(at: directory) }
        mailbox.setActive(false)
        recorder.suspendForReboot()
        try await Task.sleep(for: .milliseconds(100))
        let result = try await recorder.finish()
        XCTAssertGreaterThan(result.writtenFrames, 0)
        let manifest = try JSONDecoder().decode(RecordingManifest.self,
            from: Data(contentsOf: URL(fileURLWithPath: result.manifestPath)))
        XCTAssertEqual(manifest.deviceStates?.first?.timeMs, 0)
        XCTAssertNotNil(manifest.deviceStates?.first?.state.contentRect)
        XCTAssertEqual(manifest.interruptions?.count, 1)
        XCTAssertNil(manifest.interruptions?.first?.resumedAtSeconds)
        let tracks = try await AVURLAsset(url: directory.appendingPathComponent("recording.mp4"))
            .loadTracks(withMediaType: .video)
        XCTAssertEqual(tracks.count, 1)
    }

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
        let partial = try XCTUnwrap(JSONSerialization.jsonObject(with:
            Data(contentsOf: directory.appendingPathComponent("session.json"))) as? [String: Any])
        XCTAssertEqual(partial["status"] as? String, "failed")
        XCTAssertNotNil(partial["error"])
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
        mailbox.publish(try XCTUnwrap(frame), timestamp: .zero, wallClock: Date(),
            deviceState: .init(width: 120, height: 240, orientation: "portrait"))
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
        XCTAssertEqual(withoutContentRects(manifest.deviceStates), [
            .init(timeMs: 0, state: RecordingDeviceState(width: 120, height: 240))
        ])
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

    func testDeviceStatesStartAtFirstWrittenFrameAndTrackStaticPoseAndRotation() async throws {
        let (recorder, mailbox, directory) = try recordingFixture(canvas: .init(width: 240, height: 240))
        defer { try? FileManager.default.removeItem(at: directory) }
        recorder.start()
        // The first written PTS must differ from the timer's zero so this test
        // catches a timeline anchored to recording start instead of MP4 start.
        try await Task.sleep(for: .milliseconds(250))
        let portrait = try recordingFrame(width: 120, height: 240)
        let initial = RecordingDeviceState(
            width: 120, height: 240, orientation: "portrait", screen: .inner,
            hingeAngle: 180, physicalOrientation: "portrait", tableMode: false
        )
        mailbox.publish(portrait, timestamp: .zero, wallClock: Date(), deviceState: initial)
        try await Task.sleep(for: .milliseconds(350))

        let book = RecordingDeviceState(
            width: 120, height: 240, orientation: "portrait", screen: .inner,
            hingeAngle: 90, physicalOrientation: "portrait", tableMode: false
        )
        // Pose changes still belong in the timeline when the source pixels and
        // capture timestamp are unchanged and the recorder repeats its buffer.
        mailbox.publish(portrait, timestamp: .zero, wallClock: Date(), deviceState: book)
        try await Task.sleep(for: .milliseconds(350))

        let landscape = try recordingFrame(width: 240, height: 120)
        let tent = RecordingDeviceState(
            width: 240, height: 120, orientation: "landscape_left", screen: .outer,
            hingeAngle: 80, physicalOrientation: "facedown", tableMode: true
        )
        mailbox.publish(landscape, timestamp: CMTime(value: 1, timescale: 1),
                        wallClock: Date(), deviceState: tent)
        try await Task.sleep(for: .milliseconds(350))
        let result = try await recorder.finish()
        let manifest = try recordingManifest(result)
        let states = try XCTUnwrap(manifest.deviceStates)
        XCTAssertGreaterThan(result.sourceUnavailableTicks, 5)
        XCTAssertEqual(states.count, 3)
        XCTAssertEqual(states.map { sourceState($0.state) }, [initial, book, tent])
        XCTAssertEqual(states.map(\.state.contentRect), [
            .init(x: 60, y: 0, width: 120, height: 240),
            .init(x: 60, y: 0, width: 120, height: 240),
            .init(x: 0, y: 60, width: 240, height: 120),
        ])
        XCTAssertEqual(states.first?.timeMs, 0)
        guard states.count == 3 else { return }
        XCTAssertGreaterThan(states[1].timeMs, 200)
        XCTAssertLessThan(states[1].timeMs, 550)
        XCTAssertGreaterThan(states[2].timeMs, states[1].timeMs)
        let duration = try await AVURLAsset(url: directory.appendingPathComponent("recording.mp4"))
            .load(.duration)
        XCTAssertLessThan(states[2].timeMs, duration.seconds * 1_000)
        let sampleTimes = try await recordedSampleTimes(at: directory.appendingPathComponent("recording.mp4"))
        let firstSampleTime = try XCTUnwrap(sampleTimes.first)
        for state in states {
            XCTAssertTrue(sampleTimes.contains {
                abs(($0 - firstSampleTime) - state.timeMs) < 0.01
            }, "A state change must refer to an actual written video frame")
        }

        let second = try NativeVideoRecorder(
            mailbox: mailbox, canvas: Dimensions(width: 240, height: 240),
            outputDirectory: directory.appendingPathComponent("second").path, bitrate: 2_000_000
        )
        second.start()
        try await Task.sleep(for: .milliseconds(250))
        let secondResult = try await second.finish()
        let secondManifest = try recordingManifest(secondResult)
        XCTAssertEqual(withoutContentRects(secondManifest.deviceStates), [.init(timeMs: 0, state: tent)])
    }

    func testRecordingTracksIndependentStateChangesOnRepeatedPixels() async throws {
        let (recorder, mailbox, directory) = try recordingFixture()
        defer { try? FileManager.default.removeItem(at: directory) }
        let frame = try recordingFrame(width: 120, height: 240)
        mailbox.publish(frame, timestamp: .zero, wallClock: Date(), deviceState: RecordingDeviceState(
            width: 120, height: 240, orientation: "portrait", screen: .inner
        ))
        let poses: [CoreDeviceBridge.HingeState] = [
            .init(angle: 180, orientation: "portrait", tableMode: false),
            .init(angle: 180, orientation: "landscape-right", tableMode: false),
            .init(angle: 180, orientation: "landscape-right", tableMode: true),
            .init(angle: 90),
            .init(angle: 90, orientation: "portrait", tableMode: false),
        ]
        mailbox.updateHingeState(poses[0])
        recorder.start()
        for pose in poses {
            mailbox.updateHingeState(pose)
            try await Task.sleep(for: .milliseconds(250))
            // Repeating an unchanged pose must not add another timeline entry.
            mailbox.updateHingeState(pose)
            try await Task.sleep(for: .milliseconds(100))
        }
        var expected = poses.map { pose in
            RecordingDeviceState(
                width: 120, height: 240, orientation: "portrait", screen: .inner,
                hingeAngle: pose.angle, physicalOrientation: pose.orientation, tableMode: pose.tableMode
            )
        }
        let screens: [(String, RecordingScreen)] = [
            ("landscape_left", .inner), ("landscape_right", .inner),
            ("portrait_upside_down", .inner), ("portrait_upside_down", .outer),
        ]
        for (index, screen) in screens.enumerated() {
            let state = RecordingDeviceState(
                width: 120, height: 240, orientation: screen.0, screen: screen.1,
                hingeAngle: 90, physicalOrientation: "portrait", tableMode: false
            )
            mailbox.publish(frame, timestamp: CMTime(value: Int64(index + 1), timescale: 60),
                            wallClock: Date(), deviceState: state)
            expected.append(state)
            try await Task.sleep(for: .milliseconds(350))
        }
        let result = try await recorder.finish()
        let data = try Data(contentsOf: URL(fileURLWithPath: result.manifestPath))
        let manifest = try JSONDecoder().decode(RecordingManifest.self, from: data)
        let states = try XCTUnwrap(manifest.deviceStates)
        XCTAssertEqual(states.map { sourceState($0.state) }, expected)
        XCTAssertEqual(states.first?.timeMs, 0)
        XCTAssertGreaterThan(result.repeatedFrames, 20)
        XCTAssertEqual(result.encodeFailures, 0)
        XCTAssertEqual(result.writerDrops, 0)
        for (prior, next) in zip(states, states.dropFirst()) {
            XCTAssertGreaterThan(next.timeMs, prior.timeMs)
        }
        let object = try XCTUnwrap(JSONSerialization.jsonObject(with: data) as? [String: Any])
        let entries = try XCTUnwrap(object["deviceStates"] as? [[String: Any]])
        guard entries.count == expected.count else { return }
        let unknown = try XCTUnwrap(entries[3]["state"] as? [String: Any])
        XCTAssertNil(unknown["physicalOrientation"])
        XCTAssertNil(unknown["tableMode"])
        let restored = try XCTUnwrap(entries[4]["state"] as? [String: Any])
        XCTAssertEqual(restored["physicalOrientation"] as? String, "portrait")
        XCTAssertEqual(restored["tableMode"] as? Bool, false)
    }

    func testRapidHingeChangesAreCappedAndKeepFinalWrittenState() async throws {
        let (recorder, mailbox, directory) = try recordingFixture()
        defer { try? FileManager.default.removeItem(at: directory) }
        let frame = try recordingFrame(width: 120, height: 240)
        mailbox.publish(frame, timestamp: .zero, wallClock: Date(), deviceState: RecordingDeviceState(
            width: 120, height: 240, orientation: "portrait", screen: .inner
        ))
        mailbox.updateHingeState(.init(angle: 0))
        recorder.start()
        try await Task.sleep(for: .milliseconds(300))
        for angle in 1...60 {
            mailbox.updateHingeState(.init(angle: Double(angle)))
            try await Task.sleep(for: .milliseconds(16))
        }
        mailbox.updateHingeState(.init(angle: 90))
        try await Task.sleep(for: .milliseconds(80))
        let result = try await recorder.finish()
        let manifest = try recordingManifest(result)
        let states = try XCTUnwrap(manifest.deviceStates)
        XCTAssertEqual(states.first?.timeMs, 0)
        XCTAssertEqual(states.first?.state.hingeAngle, 0)
        XCTAssertEqual(states.last?.state.hingeAngle, 90)
        XCTAssertTrue(states.contains { (1...60).contains($0.state.hingeAngle ?? -1) })
        XCTAssertGreaterThan(result.repeatedFrames, 20)
        let sampleTimes = try await recordedSampleTimes(at: directory.appendingPathComponent("recording.mp4"))
        let firstSampleTime = try XCTUnwrap(sampleTimes.first)
        for event in states {
            XCTAssertLessThanOrEqual(states.filter {
                $0.timeMs >= event.timeMs && $0.timeMs < event.timeMs + 1_000 - 0.01
            }.count, 4)
            XCTAssertTrue(sampleTimes.contains {
                abs(($0 - firstSampleTime) - event.timeMs) < 0.01
            })
        }
        for (prior, next) in zip(states, states.dropFirst()) {
            XCTAssertNotEqual(next.state, prior.state)
        }
    }

    func testMailboxUpdatesPoseOnUnchangedFrameAndClearsUnknownFields() throws {
        let mailbox = NativeFrameMailbox()
        mailbox.setActive(true)
        let frame = try recordingFrame(width: 120, height: 240)
        let timestamp = CMTime(value: 10, timescale: 60)
        mailbox.publish(frame, timestamp: timestamp, wallClock: Date(), deviceState: RecordingDeviceState(
            width: 120, height: 240, orientation: "landscape_left", screen: .outer,
            hingeAngle: 180, physicalOrientation: "portrait", tableMode: false
        ))
        mailbox.updateHingeState(.init(angle: 80, orientation: "facedown", tableMode: true))
        let tent = try XCTUnwrap(mailbox.latest())
        XCTAssertEqual(tent.timestamp, timestamp)
        XCTAssertTrue(tent.pixelBuffer === frame)
        XCTAssertEqual(tent.deviceState, RecordingDeviceState(
            width: 120, height: 240, orientation: "landscape_left", screen: .outer,
            hingeAngle: 80, physicalOrientation: "facedown", tableMode: true
        ))

        mailbox.updateHingeState(.init(angle: 90))
        let unknown = try XCTUnwrap(mailbox.latest())
        XCTAssertEqual(unknown.timestamp, timestamp)
        XCTAssertEqual(unknown.deviceState, RecordingDeviceState(
            width: 120, height: 240, orientation: "landscape_left", screen: .outer, hingeAngle: 90
        ))
        mailbox.setActive(false)
        mailbox.setActive(true)
        mailbox.publish(frame, timestamp: timestamp, wallClock: Date())
        XCTAssertEqual(mailbox.latest()?.deviceState, RecordingDeviceState(width: 120, height: 240))
    }

    func testEncodedOuterPixelsMatchExplicitContentRectAndFullCanvas() async throws {
        let (recorder, mailbox, directory) = try recordingFixture(
            canvas: .init(width: 2008, height: 2854), bitrate: 30_000_000)
        defer { try? FileManager.default.removeItem(at: directory) }
        let source = try recordingFrame(width: 1398, height: 2034)
        mailbox.publish(source, timestamp: .zero, wallClock: Date(), deviceState: RecordingDeviceState(
            width: 1398, height: 2034, orientation: "portrait", screen: .outer
        ))
        recorder.start()
        try await Task.sleep(for: .milliseconds(350))
        let result = try await recorder.finish()
        let object = try XCTUnwrap(JSONSerialization.jsonObject(
            with: Data(contentsOf: URL(fileURLWithPath: result.manifestPath))
        ) as? [String: Any])
        let states = try XCTUnwrap(object["deviceStates"] as? [[String: Any]])
        let state = try XCTUnwrap(states.first?["state"] as? [String: Any])
        XCTAssertEqual(state["contentRect"] as? [String: Int], ["x": 24, "y": 0, "width": 1960, "height": 2854])
        let (size, bounds) = try await decodedBrightBounds(at: directory.appendingPathComponent("recording.mp4"))
        XCTAssertEqual(size, Dimensions(width: 2008, height: 2854))
        XCTAssertEqual(bounds, [24, 0, 1960, 2854])
    }

    private func recordingFixture(canvas: Dimensions = .init(width: 120, height: 240), bitrate: Int = 2_000_000) throws
        -> (NativeVideoRecorder, NativeFrameMailbox, URL) {
        let directory = FileManager.default.temporaryDirectory
            .appendingPathComponent("serve-sim-recorder-state-\(UUID().uuidString)")
        let mailbox = NativeFrameMailbox()
        mailbox.setActive(true)
        do {
            return (try NativeVideoRecorder(mailbox: mailbox, canvas: canvas,
                outputDirectory: directory.path, bitrate: bitrate), mailbox, directory)
        } catch {
            try? FileManager.default.removeItem(at: directory)
            throw error
        }
    }

    private func recordingManifest(_ result: NativeRecordingResult) throws -> RecordingManifest {
        try JSONDecoder().decode(RecordingManifest.self,
            from: Data(contentsOf: URL(fileURLWithPath: result.manifestPath)))
    }

    private func decodedBrightBounds(at url: URL) async throws -> (Dimensions, [Int]) {
        let asset = AVURLAsset(url: url)
        let tracks = try await asset.loadTracks(withMediaType: .video)
        let track = try XCTUnwrap(tracks.first)
        let reader = try AVAssetReader(asset: asset)
        let output = AVAssetReaderTrackOutput(track: track, outputSettings: [
            kCVPixelBufferPixelFormatTypeKey as String: kCVPixelFormatType_32BGRA,
        ])
        reader.add(output)
        XCTAssertTrue(reader.startReading())
        let sample = try XCTUnwrap(output.copyNextSampleBuffer())
        let buffer = try XCTUnwrap(CMSampleBufferGetImageBuffer(sample))
        reader.cancelReading()
        CVPixelBufferLockBaseAddress(buffer, .readOnly)
        defer { CVPixelBufferUnlockBaseAddress(buffer, .readOnly) }
        let size = buffer.dimensions
        let bytes = try XCTUnwrap(CVPixelBufferGetBaseAddress(buffer)).assumingMemoryBound(to: UInt8.self)
        let stride = CVPixelBufferGetBytesPerRow(buffer)
        var left = size.width, top = size.height, right = -1, bottom = -1
        for y in 0..<size.height {
            for x in 0..<size.width where bytes[y * stride + x * 4] > 128 {
                left = min(left, x); top = min(top, y)
                right = max(right, x); bottom = max(bottom, y)
            }
        }
        return (size, [left, top, right - left + 1, bottom - top + 1])
    }

    private func sourceState(_ original: RecordingDeviceState) -> RecordingDeviceState {
        XCTAssertNotNil(original.contentRect)
        var state = original
        state.contentRect = nil
        return state
    }

    private func withoutContentRects(_ entries: [RecordingManifest.DeviceState]?) -> [RecordingManifest.DeviceState]? {
        entries?.map { .init(timeMs: $0.timeMs, state: sourceState($0.state)) }
    }

    private func recordingFrame(width: Int, height: Int) throws -> CVPixelBuffer {
        var frame: CVPixelBuffer?
        let attributes: [String: Any] = [
            kCVPixelBufferIOSurfacePropertiesKey as String: [:],
        ]
        XCTAssertEqual(CVPixelBufferCreate(
            kCFAllocatorDefault, width, height,
            kCVPixelFormatType_420YpCbCr8BiPlanarVideoRange,
            attributes as CFDictionary, &frame
        ), kCVReturnSuccess)
        let owned = try XCTUnwrap(frame)
        CVPixelBufferLockBaseAddress(owned, [])
        defer { CVPixelBufferUnlockBaseAddress(owned, []) }
        memset(CVPixelBufferGetBaseAddressOfPlane(owned, 0), 235,
               CVPixelBufferGetBytesPerRowOfPlane(owned, 0) * CVPixelBufferGetHeightOfPlane(owned, 0))
        memset(CVPixelBufferGetBaseAddressOfPlane(owned, 1), 128,
               CVPixelBufferGetBytesPerRowOfPlane(owned, 1) * CVPixelBufferGetHeightOfPlane(owned, 1))
        return owned
    }

    private func recordedSampleTimes(at url: URL) async throws -> [Double] {
        let asset = AVURLAsset(url: url)
        let tracks = try await asset.loadTracks(withMediaType: .video)
        let track = try XCTUnwrap(tracks.first)
        let reader = try AVAssetReader(asset: asset)
        let output = AVAssetReaderTrackOutput(track: track, outputSettings: nil)
        reader.add(output)
        XCTAssertTrue(reader.startReading())
        var times: [Double] = []
        while let sample = output.copyNextSampleBuffer() {
            times.append(CMSampleBufferGetPresentationTimeStamp(sample).seconds * 1_000)
        }
        XCTAssertEqual(reader.status, .completed)
        return times
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
        try await transferFailureKeepsPlayableFrames(manifestFails: false)
    }

    func testManifestFailurePreservesTransferErrorAndBlocksEncoderReuse() async throws {
        try await transferFailureKeepsPlayableFrames(manifestFails: true)
    }

    private func transferFailureKeepsPlayableFrames(manifestFails: Bool) async throws {
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
            _ = try await recorder.finish(finishWriting: { writer, completion in
                writer.finishWriting {
                    if manifestFails {
                        try! FileManager.default.createDirectory(
                            at: directory.appendingPathComponent("session.json"),
                            withIntermediateDirectories: true
                        )
                    }
                    completion()
                }
            })
            XCTFail("A transfer failure must still be reported")
        } catch {
            let failure = error as NSError
            XCTAssertEqual(failure.domain, "serve-sim-recording")
            XCTAssertEqual(failure.code, 7)
            var availability = RecordingAvailability()
            availability.finalizationFailed(failure)
            XCTAssertThrowsError(try availability.checkStart())
            if manifestFails {
                XCTAssertEqual((failure.userInfo[NSUnderlyingErrorKey] as? NSError)?.code, 17)
            }
            let mp4 = directory.appendingPathComponent("recording.mp4")
            XCTAssertTrue(failure.localizedDescription.contains(mp4.path))
            let tracks = try await AVURLAsset(url: mp4).loadTracks(withMediaType: .video)
            XCTAssertFalse(tracks.isEmpty)
        }
        if manifestFails { return }
        let partial = try XCTUnwrap(JSONSerialization.jsonObject(with:
            Data(contentsOf: directory.appendingPathComponent("session.json"))) as? [String: Any])
        XCTAssertEqual(partial["status"] as? String, "failed")
        XCTAssertNotNil(partial["error"])
    }
    func testReturnedFlushFailurePreservesManifestAndPlayableVideo() async throws {
        let directory = FileManager.default.temporaryDirectory
            .appendingPathComponent("serve-sim-flush-failure-\(UUID().uuidString)")
        defer { try? FileManager.default.removeItem(at: directory) }
        let mailbox = NativeFrameMailbox()
        mailbox.setActive(true)
        var frame: CVPixelBuffer?
        XCTAssertEqual(CVPixelBufferCreate(kCFAllocatorDefault, 120, 240,
            kCVPixelFormatType_32BGRA, nil, &frame), kCVReturnSuccess)
        mailbox.publish(try XCTUnwrap(frame), timestamp: .zero, wallClock: Date(),
            deviceState: .init(width: 120, height: 240, orientation: "portrait"))
        let recorder = try NativeVideoRecorder(mailbox: mailbox,
            canvas: Dimensions(width: 120, height: 240), outputDirectory: directory.path,
            bitrate: 2_000_000)
        recorder.start()
        try await Task.sleep(for: .milliseconds(350))
        do {
            _ = try await recorder.finish(completeFrames: { session in
                _ = VTCompressionSessionCompleteFrames(session, untilPresentationTimeStamp: .invalid)
                return -19092
            })
            XCTFail("Returned flush failure must remain an error")
        } catch { XCTAssertEqual((error as NSError).code, 16) }
        let partial = try JSONDecoder().decode(RecordingManifest.self,
            from: Data(contentsOf: directory.appendingPathComponent("session.json")))
        XCTAssertEqual(partial.deviceStates?.first?.timeMs, 0)
        XCTAssertNotNil(partial.deviceStates?.first?.state.contentRect)
        XCTAssertEqual(partial.status, "failed")
        XCTAssertTrue(partial.error?.contains("-19092") == true)
        let tracks = try await AVURLAsset(url: directory.appendingPathComponent("recording.mp4"))
            .loadTracks(withMediaType: .video)
        XCTAssertFalse(tracks.isEmpty)
        let original = try Data(contentsOf: directory.appendingPathComponent("recording.mp4"))
        let next = try NativeVideoRecorder(mailbox: mailbox,
            canvas: Dimensions(width: 120, height: 240),
            outputDirectory: directory.appendingPathComponent("continuation").path, bitrate: 2_000_000)
        next.start()
        try await Task.sleep(for: .milliseconds(250))
        let result = try await next.finish()
        let completed = try JSONDecoder().decode(RecordingManifest.self,
            from: Data(contentsOf: URL(fileURLWithPath: result.manifestPath)))
        XCTAssertNil(completed.status)
        XCTAssertEqual(try Data(contentsOf: directory.appendingPathComponent("recording.mp4")), original)
    }

}
