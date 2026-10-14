import AVFoundation
import CoreMedia
import CoreVideo
import XCTest
@testable import SimNative

/// Verifies keyframe requests during continuous output and after a source pause.
final class NativeVideoRecorderKeyframeTests: XCTestCase {
    private func frame(width: Int = 120, height: Int = 240) throws -> CVPixelBuffer {
        var buffer: CVPixelBuffer?
        let attributes: [String: Any] = [kCVPixelBufferIOSurfacePropertiesKey as String: [:]]
        XCTAssertEqual(CVPixelBufferCreate(kCFAllocatorDefault, width, height, kCVPixelFormatType_420YpCbCr8BiPlanarVideoRange,
                                           attributes as CFDictionary, &buffer), kCVReturnSuccess)
        return try XCTUnwrap(buffer)
    }

    /// Records while `drive` runs, then returns each sample's time and whether it is a keyframe.
    private func record(_ drive: (NativeFrameMailbox, CVPixelBuffer) async throws -> Void) async throws -> [(seconds: Double, key: Bool)] {
        let directory = FileManager.default.temporaryDirectory
            .appendingPathComponent("serve-sim-recorder-keyframes-\(UUID().uuidString)")
        defer { try? FileManager.default.removeItem(at: directory) }
        let mailbox = NativeFrameMailbox()
        mailbox.setActive(true)
        let pixels = try frame()
        mailbox.publish(pixels, timestamp: CMTime(value: 1, timescale: 60), wallClock: Date())
        let recorder = try NativeVideoRecorder(mailbox: mailbox, canvas: Dimensions(width: 120, height: 240),
                                               outputDirectory: directory.path, bitrate: 2_000_000)
        recorder.start()
        try await drive(mailbox, pixels)
        _ = try await recorder.finish()

        let asset = AVURLAsset(url: directory.appendingPathComponent("recording.mp4"))
        let tracks = try await asset.loadTracks(withMediaType: .video)
        let reader = try AVAssetReader(asset: asset)
        let output = AVAssetReaderTrackOutput(track: try XCTUnwrap(tracks.first), outputSettings: nil)
        reader.add(output)
        XCTAssertTrue(reader.startReading())
        var samples: [(seconds: Double, key: Bool)] = []
        while let sample = output.copyNextSampleBuffer() {
            guard CMSampleBufferGetNumSamples(sample) > 0, CMSampleBufferGetDataBuffer(sample) != nil else { continue }
            let attachments = CMSampleBufferGetSampleAttachmentsArray(sample, createIfNecessary: false) as? [[CFString: Any]]
            samples.append((CMSampleBufferGetPresentationTimeStamp(sample).seconds,
                            attachments?.first?[kCMSampleAttachmentKey_NotSync] as? Bool != true))
        }
        XCTAssertEqual(reader.status, .completed)
        XCTAssertEqual(tracks.count, 1)
        let decoder = try AVAssetReader(asset: asset)
        let decoded = AVAssetReaderTrackOutput(track: try XCTUnwrap(tracks.first), outputSettings: [
            kCVPixelBufferPixelFormatTypeKey as String: kCVPixelFormatType_32BGRA
        ])
        decoder.add(decoded)
        XCTAssertTrue(decoder.startReading())
        var decodedCount = 0
        while let sample = decoded.copyNextSampleBuffer() {
            let buffer = try XCTUnwrap(CMSampleBufferGetImageBuffer(sample))
            XCTAssertEqual(CVPixelBufferGetWidth(buffer), 120)
            XCTAssertEqual(CVPixelBufferGetHeight(buffer), 240)
            decodedCount += 1
        }
        XCTAssertEqual(decoder.status, .completed)
        XCTAssertGreaterThan(decodedCount, 10)
        return samples
    }

    func testKeyframesAreAtMostOneSecondApart() async throws {
        let samples = try await record { _, _ in try await Task.sleep(for: .milliseconds(2500)) }
        let keys = samples.filter(\.key).map(\.seconds)
        XCTAssertGreaterThanOrEqual(keys.count, 2, "keyframes at \(keys)")
        for (a, b) in zip(keys, keys.dropFirst()) {
            XCTAssertLessThanOrEqual(b - a, 1.0 + 1.5 / 60, "keyframes at \(keys)")
        }
    }

    /// Ticks without a source frame write no sample, so 60 samples can span more than a second.
    /// The first sample after such a pause still comes as a keyframe.
    func testFirstSampleAfterAPauseLongerThanASecondIsAKeyframe() async throws {
        let samples = try await record { mailbox, pixels in
            try await Task.sleep(for: .milliseconds(300))
            mailbox.setActive(false)
            try await Task.sleep(for: .milliseconds(1200))
            mailbox.setActive(true)
            mailbox.publish(pixels, timestamp: CMTime(value: 1000, timescale: 60), wallClock: Date())
            try await Task.sleep(for: .milliseconds(500))
        }
        let gaps = zip(samples, samples.dropFirst()).filter { $1.seconds - $0.seconds > 1.0 }
        let resumed = try XCTUnwrap(gaps.first?.1, "no pause in \(samples.map(\.seconds))")
        XCTAssertTrue(resumed.key, "the sample at \(resumed.seconds) s after the pause is not a keyframe")
    }
    func testShortPauseResumesWithKeyframeAndStrictlyIncreasingPTS() async throws {
        let samples = try await record { mailbox, pixels in
            try await Task.sleep(for: .milliseconds(300))
            mailbox.setActive(false)
            try await Task.sleep(for: .milliseconds(200))
            mailbox.setActive(true)
            mailbox.publish(pixels, timestamp: CMTime(value: 2, timescale: 60), wallClock: Date())
            try await Task.sleep(for: .milliseconds(300))
        }
        let pairs = Array(zip(samples, samples.dropFirst()))
        XCTAssertTrue(pairs.allSatisfy { $1.seconds > $0.seconds })
        let resumed = try XCTUnwrap(pairs.first { $1.seconds - $0.seconds > 0.15 }?.1)
        XCTAssertTrue(resumed.key)
    }

    func testChangedSourceDimensionsResumeInTheSameH264Track() async throws {
        let samples = try await record { mailbox, _ in
            try await Task.sleep(for: .milliseconds(300))
            mailbox.setActive(false)
            try await Task.sleep(for: .milliseconds(200))
            let changed = try frame(width: 240, height: 120)
            mailbox.setActive(true)
            mailbox.publish(changed, timestamp: CMTime(value: 3, timescale: 60), wallClock: Date())
            try await Task.sleep(for: .milliseconds(500))
        }
        XCTAssertGreaterThan(samples.filter { $0.seconds > 0.5 }.count, 10)
        let resumed = try XCTUnwrap(zip(samples, samples.dropFirst()).first { $1.seconds - $0.seconds > 0.15 }?.1)
        XCTAssertTrue(resumed.key)
    }

}
