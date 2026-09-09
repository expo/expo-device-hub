import Foundation
import CoreVideo
import CoreMedia
import VideoToolbox

/// Real-time H.264 encoder backed by `VTCompressionSession`, producing AVCC
/// (length-prefixed NAL) output for the `/stream.avcc` endpoint.
///
/// Encoding suspends until VideoToolbox returns a sample. FrameCapture owns the
/// IOSurface snapshot, while CaptureConsumer bounds each subscriber to the
/// newest pending frame so a slow encoder cannot stall capture or other viewers.
actor H264Encoder {
    private static let encodeTimeout = DispatchTimeInterval.milliseconds(500)

    let queue = DispatchSerialQueue(label: "h264-encoder", qos: .userInteractive)
    nonisolated var unownedExecutor: UnownedSerialExecutor { queue.asUnownedSerialExecutor() }

    struct Encoded {
        /// avcC parameter-set blob — emitted once on the first IDR per session.
        let description: Data?
        let kind: Kind
        /// Length-prefixed AVCC NAL bytes (not Annex-B start codes).
        let avcc: Data
        enum Kind { case keyframe, delta }
    }

    private var session: VTCompressionSession?
    private var width: Int32 = 0
    private var height: Int32 = 0
    private var fps: Int32
    private var bitrate: Int
    private var emittedDescription = false
    private var frameCount: Int64 = 0
    private var lowLatencyEnabled = true
    private var forceKeyframeAfterReset = false
    private var encodeInFlight = false
    private var pendingSettings: (fps: Int32, bitrate: Int)?

    init(fps: Int = 60, bitrate: Int = 6_000_000) {
        self.fps = Int32(max(1, fps))
        self.bitrate = max(1, bitrate)
    }

    deinit {
        if let session { VTCompressionSessionInvalidate(session) }
    }

    /// Submit one frame and resume when VideoToolbox returns its sample.
    func encode(_ source: CVPixelBuffer, forceKeyframe: Bool = false) async throws -> Encoded {
        let w = Int32(CVPixelBufferGetWidth(source))
        let h = Int32(CVPixelBufferGetHeight(source))
        if session == nil || w != width || h != height {
            width = w
            height = h
            rebuildSession()
        }
        guard let session else {
            throw Errors.couldNotCreateSession
        }
        encodeInFlight = true
        defer {
            encodeInFlight = false
            if let pendingSettings {
                applySettings(fps: pendingSettings.fps, bitrate: pendingSettings.bitrate)
            }
        }

        frameCount += 1
        let pts = CMTime(value: frameCount, timescale: fps)
        let effectiveForceKeyframe = forceKeyframe || forceKeyframeAfterReset
        forceKeyframeAfterReset = false
        let frameProps: NSDictionary? = effectiveForceKeyframe
            ? [kVTEncodeFrameOptionKey_ForceKeyFrame: kCFBooleanTrue!] as NSDictionary
            : nil

        if let buffer = await encodeFrame(
            source,
            session: session,
            presentationTimeStamp: pts,
            frameProperties: frameProps
        ) {
            return try extract(from: buffer)
        }

        guard lowLatencyEnabled else {
            forceKeyframeAfterReset = true
            rebuildSession()
            throw Errors.encodingFailed
        }
        streamDiagnosticLog("[stream:h264] low-latency encode failed; retrying with default rate control")
        lowLatencyEnabled = false
        forceKeyframeAfterReset = true
        rebuildSession()
        guard let fallbackSession = self.session else {
            throw Errors.couldNotCreateSession
        }
        let retryProperties = [
            kVTEncodeFrameOptionKey_ForceKeyFrame: kCFBooleanTrue!,
        ] as NSDictionary
        guard let buffer = await encodeFrame(
            source,
            session: fallbackSession,
            presentationTimeStamp: pts,
            frameProperties: retryProperties
        ) else {
            throw Errors.encodingFailed
        }
        forceKeyframeAfterReset = false
        return try extract(from: buffer)
    }

    private func encodeFrame(
        _ source: CVPixelBuffer,
        session: VTCompressionSession,
        presentationTimeStamp: CMTime,
        frameProperties: NSDictionary?
    ) async -> CMSampleBuffer? {
        await withCheckedContinuation { continuation in
            let completion = EncodeCompletion(continuation)
            let timeout = DispatchWorkItem {
                streamDiagnosticLog("[stream:h264] encode timed out")
                completion.resume(returning: nil)
            }
            completion.setTimeout(timeout)
            DispatchQueue.global(qos: .userInteractive).asyncAfter(
                deadline: .now() + Self.encodeTimeout,
                execute: timeout
            )
            let status = VTCompressionSessionEncodeFrame(
                session,
                imageBuffer: source,
                presentationTimeStamp: presentationTimeStamp,
                duration: .invalid,
                frameProperties: frameProperties,
                infoFlagsOut: nil
            ) { @Sendable status, _, sampleBuffer in
                guard status == noErr, let sb = sampleBuffer else {
                    completion.resume(returning: nil)
                    return
                }
                completion.resume(returning: sb)
            }
            if status != noErr {
                completion.resume(returning: nil)
            }
        }
    }

    func update(fps nextFps: Int, bitrate nextBitrate: Int) {
        let normalizedFps = Int32(max(1, nextFps))
        let normalizedBitrate = max(1, nextBitrate)
        if encodeInFlight {
            pendingSettings = (normalizedFps, normalizedBitrate)
            return
        }
        applySettings(fps: normalizedFps, bitrate: normalizedBitrate)
    }

    private func applySettings(fps nextFps: Int32, bitrate nextBitrate: Int) {
        pendingSettings = nil
        guard fps != nextFps || bitrate != nextBitrate else { return }
        fps = nextFps
        bitrate = nextBitrate
        forceKeyframeAfterReset = true
        frameCount = 0
        if let session {
            VTCompressionSessionInvalidate(session)
            self.session = nil
        }
        emittedDescription = false
        streamDiagnosticLog("[stream:h264] settings updated fps=\(fps) bitrate=\(bitrate)")
    }

    func stop() {
        if let session {
            VTCompressionSessionInvalidate(session)
            self.session = nil
        }
    }

    // MARK: - private

    private func rebuildSession() {
        if let session {
            VTCompressionSessionInvalidate(session)
            self.session = nil
        }

        // Low-latency rate control puts VideoToolbox in its real-time/low-delay
        // pipeline and, crucially, emits a bitstream the *decoder* treats as
        // low-latency (small max_dec_frame_buffering). Without it the decoder
        // fills a large DPB before emitting, adding ~300ms of latency on the
        // client even though the stream carries no B-frames. Falls back to the
        // default spec on the rare hardware that rejects it.
        let lowLatencySpec: NSDictionary = [
            kVTVideoEncoderSpecification_EnableLowLatencyRateControl: kCFBooleanTrue!,
        ]
        var sess: VTCompressionSession?
        func create(spec: CFDictionary?) -> OSStatus {
            VTCompressionSessionCreate(
                allocator: kCFAllocatorDefault,
                width: width, height: height,
                codecType: kCMVideoCodecType_H264,
                encoderSpecification: spec,
                imageBufferAttributes: nil,
                compressedDataAllocator: kCFAllocatorDefault,
                outputCallback: nil,
                refcon: nil,
                compressionSessionOut: &sess
            )
        }
        var status: OSStatus
        if lowLatencyEnabled {
            status = create(spec: lowLatencySpec)
        } else {
            status = create(spec: nil)
        }
        if lowLatencyEnabled && (status != noErr || sess == nil) {
            streamDiagnosticLog("[stream:h264] low-latency session unavailable; using default rate control")
            lowLatencyEnabled = false
            sess = nil
            status = create(spec: nil)
        }
        guard status == noErr, let sess else { return }

        let props: [(CFString, Any)] = [
            (kVTCompressionPropertyKey_RealTime, kCFBooleanTrue!),
            (kVTCompressionPropertyKey_ProfileLevel, kVTProfileLevel_H264_High_AutoLevel),
            (kVTCompressionPropertyKey_AllowFrameReordering, kCFBooleanFalse!),
            (kVTCompressionPropertyKey_AverageBitRate, NSNumber(value: bitrate)),
            (kVTCompressionPropertyKey_ExpectedFrameRate, NSNumber(value: fps)),
            // 5s keyframe interval: IDRs are far larger than P-frames, so
            // spacing them out keeps scroll/animation smooth. Late joiners
            // don't wait for the natural IDR — we force one on connect.
            (kVTCompressionPropertyKey_MaxKeyFrameInterval, NSNumber(value: fps * 5)),
        ]
        for (key, value) in props {
            let propertyStatus = VTSessionSetProperty(sess, key: key, value: value as CFTypeRef)
            if propertyStatus != noErr {
                streamDiagnosticLog("[stream:h264] property \(key) failed with status \(propertyStatus)")
            }
        }
        let prepareStatus = VTCompressionSessionPrepareToEncodeFrames(sess)
        if prepareStatus != noErr {
            streamDiagnosticLog("[stream:h264] prepare failed with status \(prepareStatus)")
        }
        session = sess
        emittedDescription = false
    }

    private func extract(from sample: CMSampleBuffer) throws -> Encoded {
        let isKeyframe = !notSync(sample)
        guard let dataBuf = CMSampleBufferGetDataBuffer(sample) else {
            throw Errors.invalidSampleBuffer
        }

        var totalLength = 0
        var dataPointer: UnsafeMutablePointer<Int8>?
        guard CMBlockBufferGetDataPointer(
            dataBuf, atOffset: 0, lengthAtOffsetOut: nil,
            totalLengthOut: &totalLength, dataPointerOut: &dataPointer
        ) == noErr, let dataPointer else {
            throw Errors.invalidSampleBuffer
        }
        let avcc = Data(bytes: dataPointer, count: totalLength)

        var description: Data?
        if isKeyframe, let format = CMSampleBufferGetFormatDescription(sample) {
            let nextDescription = avcCBlob(from: format)
            if !emittedDescription && nextDescription != nil {
                emittedDescription = true
                description = nextDescription
            }
        }
        return Encoded(description: description, kind: isKeyframe ? .keyframe : .delta, avcc: avcc)
    }

    private func notSync(_ sample: CMSampleBuffer) -> Bool {
        guard let attachments = CMSampleBufferGetSampleAttachmentsArray(sample, createIfNecessary: false),
              CFArrayGetCount(attachments) > 0,
              let dict = CFArrayGetValueAtIndex(attachments, 0) else { return false }
        let cfDict = unsafeBitCast(dict, to: CFDictionary.self)
        return CFDictionaryContainsKey(cfDict, Unmanaged.passUnretained(kCMSampleAttachmentKey_NotSync).toOpaque())
    }

    /// avcC parameter-set blob (ISO/IEC 14496-15 §5.2.4.1) carrying SPS + PPS.
    private func avcCBlob(from format: CMFormatDescription) -> Data? {
        var spsCount = 0
        var spsPtr: UnsafePointer<UInt8>?
        var spsSize = 0
        var nalSize: Int32 = 0
        guard CMVideoFormatDescriptionGetH264ParameterSetAtIndex(
            format, parameterSetIndex: 0,
            parameterSetPointerOut: &spsPtr, parameterSetSizeOut: &spsSize,
            parameterSetCountOut: &spsCount, nalUnitHeaderLengthOut: &nalSize
        ) == noErr, let spsPtr, spsSize >= 4 else { return nil }

        var ppsPtr: UnsafePointer<UInt8>?
        var ppsSize = 0
        guard CMVideoFormatDescriptionGetH264ParameterSetAtIndex(
            format, parameterSetIndex: 1,
            parameterSetPointerOut: &ppsPtr, parameterSetSizeOut: &ppsSize,
            parameterSetCountOut: nil, nalUnitHeaderLengthOut: nil
        ) == noErr, let ppsPtr else { return nil }

        let sps = UnsafeBufferPointer(start: spsPtr, count: spsSize)
        let pps = UnsafeBufferPointer(start: ppsPtr, count: ppsSize)
        var blob = Data()
        blob.append(0x01)
        blob.append(sps[1]); blob.append(sps[2]); blob.append(sps[3])
        blob.append(0xFF)
        blob.append(0xE1)
        blob.append(UInt8((spsSize >> 8) & 0xFF)); blob.append(UInt8(spsSize & 0xFF))
        blob.append(contentsOf: sps)
        blob.append(0x01)
        blob.append(UInt8((ppsSize >> 8) & 0xFF)); blob.append(UInt8(ppsSize & 0xFF))
        blob.append(contentsOf: pps)
        return blob
    }

    enum Errors: Error {
        case couldNotCreateSession
        case encodingFailed
        case invalidSampleBuffer
    }
}

private final class EncodeCompletion: @unchecked Sendable {
    private let lock = NSLock()
    private var continuation: CheckedContinuation<CMSampleBuffer?, Never>?
    private var timeout: DispatchWorkItem?

    init(_ continuation: CheckedContinuation<CMSampleBuffer?, Never>) {
        self.continuation = continuation
    }

    func setTimeout(_ timeout: DispatchWorkItem) {
        lock.lock()
        self.timeout = timeout
        lock.unlock()
    }

    func resume(returning sampleBuffer: CMSampleBuffer?) {
        lock.lock()
        let continuation = self.continuation
        self.continuation = nil
        let timeout = self.timeout
        self.timeout = nil
        lock.unlock()
        timeout?.cancel()
        continuation?.resume(returning: sampleBuffer)
    }
}
