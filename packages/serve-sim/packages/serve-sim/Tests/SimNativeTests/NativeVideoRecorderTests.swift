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
        XCTAssertEqual(manifest.deviceStates, [
            .init(timeMs: 0, state: RecordingDeviceState(width: 120, height: 240))
        ])
        let asset = AVURLAsset(url: directory.appendingPathComponent("recording.mp4"))
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
        let directory = FileManager.default.temporaryDirectory
            .appendingPathComponent("serve-sim-recorder-state-\(UUID().uuidString)")
        defer { try? FileManager.default.removeItem(at: directory) }
        let mailbox = NativeFrameMailbox()
        mailbox.setActive(true)
        let recorder = try NativeVideoRecorder(
            mailbox: mailbox, canvas: Dimensions(width: 240, height: 240),
            outputDirectory: directory.path, bitrate: 2_000_000
        )
        recorder.start()
        // The first written PTS must differ from the timer's zero so this test
        // catches a timeline anchored to recording start instead of MP4 start.
        try await Task.sleep(for: .milliseconds(250))
        let portrait = try recordingFrame(width: 120, height: 240)
        let initial = RecordingDeviceState(
            width: 120, height: 240, orientation: "portrait", screenId: 0,
            hingeAngle: 180, physicalOrientation: "portrait", tableMode: false
        )
        mailbox.publish(portrait, timestamp: .zero, wallClock: Date(), deviceState: initial)
        try await Task.sleep(for: .milliseconds(350))

        let book = RecordingDeviceState(
            width: 120, height: 240, orientation: "portrait", screenId: 0,
            hingeAngle: 90, physicalOrientation: "portrait", tableMode: false
        )
        // Pose changes still belong in the timeline when the source pixels and
        // capture timestamp are unchanged and the recorder repeats its buffer.
        mailbox.publish(portrait, timestamp: .zero, wallClock: Date(), deviceState: book)
        try await Task.sleep(for: .milliseconds(350))

        let landscape = try recordingFrame(width: 240, height: 120)
        let tent = RecordingDeviceState(
            width: 240, height: 120, orientation: "landscape_left", screenId: 1,
            hingeAngle: 80, physicalOrientation: "facedown", tableMode: true
        )
        mailbox.publish(landscape, timestamp: CMTime(value: 1, timescale: 1),
                        wallClock: Date(), deviceState: tent)
        try await Task.sleep(for: .milliseconds(350))
        let result = try await recorder.finish()
        let manifest = try JSONDecoder().decode(
            RecordingManifest.self,
            from: Data(contentsOf: URL(fileURLWithPath: result.manifestPath))
        )
        let states = try XCTUnwrap(manifest.deviceStates)
        XCTAssertGreaterThan(result.sourceUnavailableTicks, 5)
        XCTAssertEqual(states.count, 3)
        XCTAssertEqual(states.map(\.state), [initial, book, tent])
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
        let secondManifest = try JSONDecoder().decode(
            RecordingManifest.self,
            from: Data(contentsOf: URL(fileURLWithPath: secondResult.manifestPath))
        )
        XCTAssertEqual(secondManifest.deviceStates, [.init(timeMs: 0, state: tent)])
    }

    func testRecordingTracksIndependentStateChangesOnRepeatedPixels() async throws {
        let directory = FileManager.default.temporaryDirectory
            .appendingPathComponent("serve-sim-recorder-static-pose-\(UUID().uuidString)")
        defer { try? FileManager.default.removeItem(at: directory) }
        let mailbox = NativeFrameMailbox()
        mailbox.setActive(true)
        let frame = try recordingFrame(width: 120, height: 240)
        mailbox.publish(frame, timestamp: .zero, wallClock: Date(), deviceState: RecordingDeviceState(
            width: 120, height: 240, orientation: "portrait", screenId: 0
        ))
        let poses: [CoreDeviceBridge.HingeState] = [
            .init(angle: 180, orientation: "portrait", tableMode: false),
            .init(angle: 180, orientation: "landscape-right", tableMode: false),
            .init(angle: 180, orientation: "landscape-right", tableMode: true),
            .init(angle: 90),
            .init(angle: 90, orientation: "portrait", tableMode: false),
        ]
        mailbox.updateHingeState(poses[0])
        let recorder = try NativeVideoRecorder(
            mailbox: mailbox, canvas: Dimensions(width: 120, height: 240),
            outputDirectory: directory.path, bitrate: 2_000_000
        )
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
                width: 120, height: 240, orientation: "portrait", screenId: 0,
                hingeAngle: pose.angle, physicalOrientation: pose.orientation, tableMode: pose.tableMode
            )
        }
        let screens: [(String, UInt32)] = [
            ("landscape_left", 0), ("landscape_right", 0),
            ("portrait_upside_down", 0), ("portrait_upside_down", 1),
        ]
        for (index, screen) in screens.enumerated() {
            let state = RecordingDeviceState(
                width: 120, height: 240, orientation: screen.0, screenId: screen.1,
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
        XCTAssertEqual(states.map(\.state), expected)
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
        let directory = FileManager.default.temporaryDirectory
            .appendingPathComponent("serve-sim-recorder-hinge-rate-\(UUID().uuidString)")
        defer { try? FileManager.default.removeItem(at: directory) }
        let mailbox = NativeFrameMailbox()
        mailbox.setActive(true)
        let frame = try recordingFrame(width: 120, height: 240)
        mailbox.publish(frame, timestamp: .zero, wallClock: Date(), deviceState: RecordingDeviceState(
            width: 120, height: 240, orientation: "portrait", screenId: 0
        ))
        mailbox.updateHingeState(.init(angle: 0))
        let recorder = try NativeVideoRecorder(
            mailbox: mailbox, canvas: Dimensions(width: 120, height: 240),
            outputDirectory: directory.path, bitrate: 2_000_000
        )
        recorder.start()
        try await Task.sleep(for: .milliseconds(300))
        for angle in 1...60 {
            mailbox.updateHingeState(.init(angle: Double(angle)))
            try await Task.sleep(for: .milliseconds(16))
        }
        mailbox.updateHingeState(.init(angle: 90))
        try await Task.sleep(for: .milliseconds(80))
        let result = try await recorder.finish()
        let manifest = try JSONDecoder().decode(
            RecordingManifest.self,
            from: Data(contentsOf: URL(fileURLWithPath: result.manifestPath))
        )
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
            width: 120, height: 240, orientation: "landscape_left", screenId: 1,
            hingeAngle: 180, physicalOrientation: "portrait", tableMode: false
        ))
        mailbox.updateHingeState(.init(angle: 80, orientation: "facedown", tableMode: true))
        let tent = try XCTUnwrap(mailbox.latest())
        XCTAssertEqual(tent.timestamp, timestamp)
        XCTAssertTrue(tent.pixelBuffer === frame)
        XCTAssertEqual(tent.deviceState, RecordingDeviceState(
            width: 120, height: 240, orientation: "landscape_left", screenId: 1,
            hingeAngle: 80, physicalOrientation: "facedown", tableMode: true
        ))

        mailbox.updateHingeState(.init(angle: 90))
        let unknown = try XCTUnwrap(mailbox.latest())
        XCTAssertEqual(unknown.timestamp, timestamp)
        XCTAssertEqual(unknown.deviceState, RecordingDeviceState(
            width: 120, height: 240, orientation: "landscape_left", screenId: 1, hingeAngle: 90
        ))
        mailbox.setActive(false)
        mailbox.setActive(true)
        mailbox.publish(frame, timestamp: timestamp, wallClock: Date())
        XCTAssertEqual(mailbox.latest()?.deviceState, RecordingDeviceState(width: 120, height: 240))
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
