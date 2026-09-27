import AVFoundation
import CoreMedia
import CoreVideo
import Foundation
import StreamingPolicy
import VideoToolbox

struct NativeRecordingResult: Sendable {
    let manifestPath: String
    let encoderID: String
    let encodedFrames: UInt64
    let writtenFrames: UInt64
    let repeatedFrames: UInt64
    let droppedTicks: UInt64
    let coalescedDrops: UInt64
    let sourceUnavailableTicks: UInt64
    let transferPoolDrops: UInt64
    let inFlightDrops: UInt64
    let writerDrops: UInt64
    let writerBackpressureTicks: UInt64
    let encodeFailures: UInt64
    let maxInFlight: Int
    let meanEncodeMs: Double
    let maxEncodeMs: Double
}

private final class RecordingFinishLatch: @unchecked Sendable {
    private let lock = NSLock()
    private var continuation: CheckedContinuation<NativeRecordingResult, Error>?

    init(_ continuation: CheckedContinuation<NativeRecordingResult, Error>) {
        self.continuation = continuation
    }

    var pending: Bool {
        lock.lock()
        defer { lock.unlock() }
        return continuation != nil
    }

    func resolve(_ result: Result<NativeRecordingResult, Error>) {
        lock.lock()
        let current = continuation
        continuation = nil
        lock.unlock()
        current?.resume(with: result)
    }
}

final class NativeVideoRecorder: @unchecked Sendable {
    private static let maxPendingFrames = 16
    private let queue = DispatchQueue(label: "serve-sim-native-recording", qos: .userInteractive)
    private let mailbox: NativeFrameMailbox
    private let canvas: Dimensions
    private let outputDirectory: URL
    private let letterboxer = PixelBufferLetterboxer(allowCPUFallback: false, maxBuffers: 20)
    private let encoderID: String
    private var session: VTCompressionSession?
    private var timer: DispatchSourceTimer?
    private var writer: AVAssetWriter?
    private var input: AVAssetWriterInput?
    private var firstFrameWallClock: Date?
    private var lastSnapshotTimestamp: CMTime?
    private var canvasBuffer: CVPixelBuffer?
    private var startNanoseconds: UInt64 = 0
    private var startWallClock = Date()
    private var lastTick: Int64 = -1
    private var pending = Set<Int64>()
    private var lastWrittenPTS: CMTime = .negativeInfinity
    private var awaitingKeyframe = true
    private var forceIDR = true
    private var closing = false
    private var failure: Error?
    private var encodedFrames: UInt64 = 0
    private var writtenFrames: UInt64 = 0
    private var repeatedFrames: UInt64 = 0
    private var droppedTicks: UInt64 = 0
    private var coalescedDrops: UInt64 = 0
    private var sourceUnavailableTicks: UInt64 = 0
    private var transferPoolDrops: UInt64 = 0
    private var inFlightDrops: UInt64 = 0
    private var writerDrops: UInt64 = 0
    private var writerBackpressureTicks: UInt64 = 0
    private var encodeFailures: UInt64 = 0
    private var maxInFlight = 0
    private var encodeTimeSumNs: UInt64 = 0
    private var encodeTimeMaxNs: UInt64 = 0
    private var encodeCompletions: UInt64 = 0

    init(mailbox: NativeFrameMailbox, canvas: Dimensions, outputDirectory: String,
         bitrate: Int = 30_000_000) throws {
        guard canvas.width > 0, canvas.height > 0,
              canvas.width < Int32.max, canvas.height < Int32.max else {
            throw Self.error(1, "Recording canvas must have positive dimensions below \(Int32.max)")
        }
        let encodeCanvas = Dimensions(
            width: canvas.width + canvas.width % 2,
            height: canvas.height + canvas.height % 2
        )
        self.mailbox = mailbox
        self.canvas = encodeCanvas
        self.outputDirectory = URL(fileURLWithPath: outputDirectory, isDirectory: true)
        try FileManager.default.createDirectory(at: self.outputDirectory,
                                                withIntermediateDirectories: true)
        let mp4 = self.outputDirectory.appendingPathComponent("recording.mp4")
        guard !FileManager.default.fileExists(atPath: mp4.path) else {
            throw Self.error(2, "Recording output already exists at \(mp4.path)")
        }

        let specification: NSDictionary = [
            kVTVideoEncoderSpecification_RequireHardwareAcceleratedVideoEncoder: kCFBooleanTrue!,
        ]
        var created: VTCompressionSession?
        let status = VTCompressionSessionCreate(
            allocator: kCFAllocatorDefault,
            width: Int32(encodeCanvas.width), height: Int32(encodeCanvas.height),
            codecType: kCMVideoCodecType_H264,
            encoderSpecification: specification,
            imageBufferAttributes: nil,
            compressedDataAllocator: nil,
            outputCallback: nil, refcon: nil,
            compressionSessionOut: &created
        )
        guard status == noErr, let created else {
            throw Self.error(3, "Hardware H.264 recording encoder could not start (status \(status))")
        }
        do {
            for (key, value) in [
                (kVTCompressionPropertyKey_RealTime, kCFBooleanTrue! as Any),
                (kVTCompressionPropertyKey_ProfileLevel, kVTProfileLevel_H264_High_AutoLevel as Any),
                (kVTCompressionPropertyKey_AllowFrameReordering, kCFBooleanFalse! as Any),
                (kVTCompressionPropertyKey_AverageBitRate, NSNumber(value: max(1, bitrate)) as Any),
                (kVTCompressionPropertyKey_ExpectedFrameRate, NSNumber(value: 60) as Any),
                (kVTCompressionPropertyKey_MaxKeyFrameInterval, NSNumber(value: 120) as Any),
            ] {
                let result = VTSessionSetProperty(created, key: key, value: value as CFTypeRef)
                guard result == noErr else {
                    throw Self.error(4, "Recording encoder rejected \(key) (status \(result))")
                }
            }
            let prepared = VTCompressionSessionPrepareToEncodeFrames(created)
            guard prepared == noErr else {
                throw Self.error(5, "Recording encoder preparation failed (status \(prepared))")
            }
            var hardware: CFTypeRef?
            var identity: CFTypeRef?
            let hardwareStatus = withUnsafeMutablePointer(to: &hardware) { pointer in
                VTSessionCopyProperty(created,
                                      key: kVTCompressionPropertyKey_UsingHardwareAcceleratedVideoEncoder,
                                      allocator: kCFAllocatorDefault, valueOut: pointer)
            }
            _ = withUnsafeMutablePointer(to: &identity) { pointer in
                VTSessionCopyProperty(created, key: kVTCompressionPropertyKey_EncoderID,
                                      allocator: kCFAllocatorDefault, valueOut: pointer)
            }
            guard hardwareStatus == noErr, (hardware as? NSNumber)?.boolValue == true else {
                throw Self.error(6, "Recording encoder did not report hardware acceleration")
            }
            encoderID = (identity as? String) ?? "hardware H.264"
            session = created
        } catch {
            VTCompressionSessionInvalidate(created)
            throw error
        }
    }

    deinit {
        timer?.cancel()
        if let session { VTCompressionSessionInvalidate(session) }
    }

    func start() {
        queue.async {
            guard self.timer == nil, !self.closing else { return }
            self.startNanoseconds = DispatchTime.now().uptimeNanoseconds
            self.startWallClock = Date()
            let timer = DispatchSource.makeTimerSource(queue: self.queue)
            timer.schedule(deadline: .now(), repeating: .nanoseconds(16_666_667))
            timer.setEventHandler { [weak self] in self?.tick() }
            self.timer = timer
            timer.resume()
        }
    }

    private func tick() {
        guard !closing, failure == nil, let session else { return }
        let now = DispatchTime.now().uptimeNanoseconds
        let currentIndex = Int64((now - startNanoseconds) / 16_666_667)
        guard currentIndex > lastTick else { return }
        if currentIndex > lastTick + 1 {
            let missed = UInt64(currentIndex - lastTick - 1)
            droppedTicks &+= missed
            coalescedDrops &+= missed
        }
        lastTick = currentIndex
        submit(index: currentIndex, session: session)
    }

    private func submit(index: Int64, session: VTCompressionSession) {
        guard let frame = mailbox.latest() else {
            droppedTicks &+= 1
            sourceUnavailableTicks &+= 1
            return
        }
        guard pending.count < Self.maxPendingFrames else {
            droppedTicks &+= 1
            inFlightDrops &+= 1
            return
        }
        if let input, !input.isReadyForMoreMediaData {
            writerBackpressureTicks &+= 1
            droppedTicks &+= 1
            awaitingKeyframe = true
            forceIDR = true
            return
        }
        if lastSnapshotTimestamp != frame.timestamp || canvasBuffer == nil {
            let buffer: CVPixelBuffer?
            if frame.pixelBuffer.dimensions == canvas {
                buffer = frame.pixelBuffer
            } else {
                let priorDrops = letterboxer.poolDrops
                buffer = letterboxer.place(frame.pixelBuffer,
                                            width: canvas.width, height: canvas.height)
                if buffer == nil, letterboxer.poolDrops == priorDrops {
                    failure = Self.error(7, "Hardware pixel transfer for recording failed")
                    timer?.cancel()
                    return
                }
            }
            guard let buffer else {
                droppedTicks &+= 1
                transferPoolDrops &+= 1
                return
            }
            canvasBuffer = buffer
            lastSnapshotTimestamp = frame.timestamp
        } else {
            repeatedFrames &+= 1
        }
        guard let canvasBuffer else { return }
        let pts = CMTime(value: index, timescale: 60)
        let wallClock = startWallClock.addingTimeInterval(Double(index) / 60)
        let properties: NSDictionary? = forceIDR
            ? [kVTEncodeFrameOptionKey_ForceKeyFrame: kCFBooleanTrue!] : nil
        forceIDR = false
        pending.insert(index)
        maxInFlight = max(maxInFlight, pending.count)
        let encodeStartNs = DispatchTime.now().uptimeNanoseconds
        let status = VTCompressionSessionEncodeFrame(
            session, imageBuffer: canvasBuffer,
            presentationTimeStamp: pts,
            duration: CMTime(value: 1, timescale: 60),
            frameProperties: properties,
            infoFlagsOut: nil
        ) { [weak self] result, _, sample in
            guard let self else { return }
            let elapsedNs = DispatchTime.now().uptimeNanoseconds - encodeStartNs
            self.queue.async {
                self.complete(index: index, pts: pts, wallClock: wallClock,
                              status: result, sample: sample, encodeElapsedNs: elapsedNs)
            }
        }
        if status != noErr {
            complete(index: index, pts: pts, wallClock: wallClock,
                     status: status, sample: nil,
                     encodeElapsedNs: DispatchTime.now().uptimeNanoseconds - encodeStartNs)
        }
    }

    private func complete(index: Int64, pts: CMTime, wallClock: Date,
                          status: OSStatus, sample: CMSampleBuffer?, encodeElapsedNs: UInt64) {
        guard pending.remove(index) != nil else { return }
        encodeCompletions &+= 1
        encodeTimeSumNs &+= encodeElapsedNs
        encodeTimeMaxNs = max(encodeTimeMaxNs, encodeElapsedNs)
        guard status == noErr, let sample else {
            encodeFailures &+= 1
            awaitingKeyframe = true
            forceIDR = true
            return
        }
        encodedFrames &+= 1
        guard pts > lastWrittenPTS else {
            writerDrops &+= 1
            awaitingKeyframe = true
            forceIDR = true
            return
        }
        let keyframe = Self.isKeyframe(sample)
        if awaitingKeyframe && !keyframe {
            forceIDR = true
            return
        }
        if writer == nil {
            do {
                try openWriter(sample: sample)
            } catch {
                failure = error
                timer?.cancel()
                return
            }
        }
        guard let input, input.isReadyForMoreMediaData else {
            writerDrops &+= 1
            awaitingKeyframe = true
            forceIDR = true
            return
        }
        var timing = CMSampleTimingInfo(
            duration: CMTime(value: 1, timescale: 60),
            presentationTimeStamp: pts, decodeTimeStamp: .invalid
        )
        var retimed: CMSampleBuffer?
        let result = CMSampleBufferCreateCopyWithNewTiming(
            allocator: kCFAllocatorDefault, sampleBuffer: sample,
            sampleTimingEntryCount: 1, sampleTimingArray: &timing,
            sampleBufferOut: &retimed
        )
        guard result == noErr, let retimed else {
            failure = Self.error(8, "Could not retime the recorded H.264 frame")
            timer?.cancel()
            return
        }
        if firstFrameWallClock == nil {
            writer?.startSession(atSourceTime: pts)
        }
        guard input.append(retimed) else {
            failure = writer?.error ?? Self.error(8, "Could not append the recorded H.264 frame")
            timer?.cancel()
            return
        }
        lastWrittenPTS = pts
        writtenFrames &+= 1
        awaitingKeyframe = false
        if firstFrameWallClock == nil { firstFrameWallClock = wallClock }
    }

    private func openWriter(sample: CMSampleBuffer) throws {
        guard let format = CMSampleBufferGetFormatDescription(sample) else {
            throw Self.error(9, "Recorded H.264 keyframe had no format description")
        }
        let url = outputDirectory.appendingPathComponent("recording.mp4")
        let writer = try AVAssetWriter(outputURL: url, fileType: .mp4)
        let input = AVAssetWriterInput(mediaType: .video, outputSettings: nil,
                                       sourceFormatHint: format)
        input.expectsMediaDataInRealTime = true
        guard writer.canAdd(input) else {
            throw Self.error(10, "MP4 writer could not accept the hardware H.264 stream")
        }
        writer.add(input)
        guard writer.startWriting() else {
            throw writer.error ?? Self.error(11, "MP4 writer failed to start")
        }
        self.writer = writer
        self.input = input
    }

    func finish() async throws -> NativeRecordingResult {
        try await withCheckedThrowingContinuation { continuation in
            let latch = RecordingFinishLatch(continuation)
            queue.asyncAfter(deadline: .now() + 60) { [weak self] in
                guard latch.pending else { return }
                let error = Self.error(15, "Recording finalization timed out after 60 seconds")
                self?.failure = error
                self?.timer?.cancel()
                self?.writer?.cancelWriting()
                latch.resolve(.failure(error))
            }
            queue.async {
                guard latch.pending else { return }
                guard !self.closing else {
                    latch.resolve(.failure(Self.error(12, "Recording is already stopping")))
                    return
                }
                self.closing = true
                self.timer?.cancel()
                self.timer = nil
                if let session = self.session {
                    DispatchQueue.global(qos: .userInitiated).async {
                        let status = VTCompressionSessionCompleteFrames(
                            session, untilPresentationTimeStamp: .invalid
                        )
                        self.queue.async {
                            if status != noErr {
                                self.failure = Self.error(
                                    16, "Recording encoder flush failed (status \(status))"
                                )
                            }
                            self.finishOnQueue(latch)
                        }
                    }
                } else {
                    self.finishOnQueue(latch)
                }
            }
        }
    }

    private func finishOnQueue(_ latch: RecordingFinishLatch) {
        if let session {
            VTCompressionSessionInvalidate(session)
            self.session = nil
        }
        guard latch.pending else { return }
        if let failure {
            writer?.cancelWriting()
            latch.resolve(.failure(failure))
            return
        }
        guard let writer, let input, let firstFrameWallClock else {
            latch.resolve(.failure(Self.error(
                13, "No H.264 frame was recorded; check the simulator display and retry"
            )))
            return
        }
        input.markAsFinished()
        writer.finishWriting {
            self.queue.async {
                self.finishWriter(writer, firstFrameWallClock: firstFrameWallClock, latch: latch)
            }
        }
    }

    private func finishWriter(_ writer: AVAssetWriter, firstFrameWallClock: Date,
                              latch: RecordingFinishLatch) {
        guard latch.pending else { return }
        do {
            guard writer.status == .completed else {
                throw writer.error ?? Self.error(14, "MP4 writer did not finish")
            }
            let manifest = RecordingManifest(
                firstFrame: firstFrameWallClock,
                width: canvas.width, height: canvas.height
            )
            let encoder = JSONEncoder()
            encoder.outputFormatting = [.prettyPrinted, .sortedKeys]
            let path = outputDirectory.appendingPathComponent("session.json")
            do {
                try encoder.encode(manifest).write(to: path, options: .atomic)
            } catch {
                throw Self.error(17, "MP4 saved at \(writer.outputURL.path), but session.json could not be written: \(error.localizedDescription). Choose a new empty output directory to retry; the partial output is preserved.")
            }
            latch.resolve(.success(NativeRecordingResult(
                manifestPath: path.path, encoderID: encoderID,
                encodedFrames: encodedFrames, writtenFrames: writtenFrames,
                repeatedFrames: repeatedFrames,
                droppedTicks: droppedTicks, coalescedDrops: coalescedDrops,
                sourceUnavailableTicks: sourceUnavailableTicks,
                transferPoolDrops: transferPoolDrops, inFlightDrops: inFlightDrops,
                writerDrops: writerDrops,
                writerBackpressureTicks: writerBackpressureTicks,
                encodeFailures: encodeFailures, maxInFlight: maxInFlight,
                meanEncodeMs: encodeCompletions == 0 ? 0
                    : Double(encodeTimeSumNs) / Double(encodeCompletions) / 1_000_000,
                maxEncodeMs: Double(encodeTimeMaxNs) / 1_000_000
            )))
        } catch {
            latch.resolve(.failure(error))
        }
    }

    static func isKeyframe(_ sample: CMSampleBuffer) -> Bool {
        guard let attachments = CMSampleBufferGetSampleAttachmentsArray(sample,
                                                                        createIfNecessary: false),
              CFArrayGetCount(attachments) > 0,
              let values = CFArrayGetValueAtIndex(attachments, 0) else { return true }
        let dictionary = unsafeBitCast(values, to: CFDictionary.self)
        return !CFDictionaryContainsKey(dictionary,
            Unmanaged.passUnretained(kCMSampleAttachmentKey_NotSync).toOpaque())
    }

    private static func error(_ code: Int, _ message: String) -> NSError {
        NSError(domain: "serve-sim-recording", code: code,
                userInfo: [NSLocalizedDescriptionKey: message])
    }
}
