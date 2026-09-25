import CoreMedia
import Foundation
import VideoToolbox

struct StreamConfig: Equatable {
    let codec: String       // WebCodecs codec string, e.g. "avc1.640028"
    let width: Int
    let height: Int
    let description: Data   // avcC box (SPS/PPS) for VideoDecoder.configure
}

/// The most recent input injected before a frame was captured, so latency can be traced from the
/// client's touch to the pixels it caused.
struct InputTag {
    var seq: UInt32 = 0          // 0 = none
    var receivedMs: Double = 0   // server clock, when the input arrived
}

struct EncodedFrame {
    var seq: UInt32
    let data: Data          // AVCC (length-prefixed NAL units)
    let isKeyframe: Bool
    let config: StreamConfig?
    let captureMs: Double
    let encodeStartMs: Double   // submitted to the encoder (after any queueing)
    let encodedMs: Double
    let input: InputTag
    /// Size the client should present at, when frames are encoded at a reduced resolution.
    var displaySize: (width: Int, height: Int)?
}

/// Hardware H.264 tuned for interactive streaming: low-latency rate control, no B-frames,
/// keyframes on demand rather than on a fixed GOP. One per viewer.
final class H264Encoder {
    let width: Int
    let height: Int
    var onFrame: ((EncodedFrame) -> Void)?

    private let session: VTCompressionSession
    private var seq: UInt32 = 0
    private(set) var bitrate: Int

    struct Stats {
        var frames = 0, bytes = 0, keyframes = 0, maxBytes = 0, encodeMs = 0.0, queueMs = 0.0
        /// Frames the encoder dropped itself (its rate control couldn't fit them in the budget).
        var dropped = 0
        var psnrSum = 0.0, psnrMin = Double.infinity, psnrCount = 0
    }
    /// When set, every frame is decoded back and compared with its source (luma PSNR).
    var quality: QualityProbe?
    private var stats = Stats()
    /// Running totals since this encoder was created (not reset by `takeStats`).
    private var encodedTotal = 0, droppedTotal = 0

    func frameTotals() -> (encoded: Int, dropped: Int) {
        statsLock.lock()
        defer { statsLock.unlock() }
        return (encodedTotal, droppedTotal)
    }
    private let statsLock = NSLock()

    /// Returns and resets the counters accumulated since the last call.
    func takeStats() -> Stats {
        statsLock.lock()
        defer { stats = Stats(); statsLock.unlock() }
        return stats
    }

    init(width: Int, height: Int, fps: Int, bitrate: Int) throws {
        self.width = width
        self.height = height
        self.bitrate = bitrate

        let spec: [CFString: Any] = [
            kVTVideoEncoderSpecification_EnableLowLatencyRateControl: true,
            kVTVideoEncoderSpecification_RequireHardwareAcceleratedVideoEncoder: true,
        ]
        var created: VTCompressionSession?
        let status = VTCompressionSessionCreate(
            allocator: nil, width: Int32(width), height: Int32(height),
            codecType: kCMVideoCodecType_H264, encoderSpecification: spec as CFDictionary,
            imageBufferAttributes: nil, compressedDataAllocator: nil,
            outputCallback: nil, refcon: nil, compressionSessionOut: &created)
        guard status == noErr, let created else {
            throw SimStreamError("VTCompressionSessionCreate failed (\(status))")
        }
        session = created

        set(kVTCompressionPropertyKey_RealTime, kCFBooleanTrue)
        set(kVTCompressionPropertyKey_AllowFrameReordering, kCFBooleanFalse)
        if !set(kVTCompressionPropertyKey_ProfileLevel, kVTProfileLevel_H264_ConstrainedHigh_AutoLevel) {
            set(kVTCompressionPropertyKey_ProfileLevel, kVTProfileLevel_H264_High_AutoLevel)
        }
        set(kVTCompressionPropertyKey_AverageBitRate, bitrate as CFNumber)
        set(kVTCompressionPropertyKey_ExpectedFrameRate, fps as CFNumber)
        // Keyframes are requested per viewer (join, resume, decoder error, resync). The transport is
        // reliable, so a periodic refresh would only cost a burst of bits on constrained links.
        set(kVTCompressionPropertyKey_MaxKeyFrameIntervalDuration, 60 as CFNumber)
        set(kVTCompressionPropertyKey_ColorPrimaries, kCVImageBufferColorPrimaries_ITU_R_709_2)
        set(kVTCompressionPropertyKey_TransferFunction, kCVImageBufferTransferFunction_ITU_R_709_2)
        set(kVTCompressionPropertyKey_YCbCrMatrix, kCVImageBufferYCbCrMatrix_ITU_R_709_2)
        VTCompressionSessionPrepareToEncodeFrames(session)
    }

    deinit {
        VTCompressionSessionInvalidate(session)
    }

    @discardableResult
    private func set(_ key: CFString, _ value: CFTypeRef) -> Bool {
        VTSessionSetProperty(session, key: key, value: value) == noErr
    }

    func setBitrate(_ bps: Int) {
        bitrate = bps
        set(kVTCompressionPropertyKey_AverageBitRate, bps as CFNumber)
    }

    /// `completion` runs once the encoder is done with the frame, whether or not it produced output.
    func encode(_ pixelBuffer: CVPixelBuffer, captureMs: Double, forceKeyframe: Bool, input: InputTag,
                completion: @escaping () -> Void = {}) {
        let encodeStartMs = Clock.ms()
        let pts = CMTime(value: CMTimeValue(captureMs * 1000), timescale: 1_000_000)
        let props = forceKeyframe ? [kVTEncodeFrameOptionKey_ForceKeyFrame: true] as CFDictionary : nil
        VTCompressionSessionEncodeFrame(
            session, imageBuffer: pixelBuffer, presentationTimeStamp: pts, duration: .invalid,
            frameProperties: props, infoFlagsOut: nil
        ) { [weak self] status, infoFlags, sampleBuffer in
            defer { completion() }
            if infoFlags.contains(.frameDropped), let self {
                self.statsLock.lock()
                self.stats.dropped += 1
                self.droppedTotal += 1
                self.statsLock.unlock()
            }
            guard let self, status == noErr, let sampleBuffer, CMSampleBufferDataIsReady(sampleBuffer) else { return }
            if let psnr = self.quality?.measure(sampleBuffer, against: pixelBuffer) {
                self.statsLock.lock()
                self.stats.psnrSum += psnr
                self.stats.psnrMin = min(self.stats.psnrMin, psnr)
                self.stats.psnrCount += 1
                self.statsLock.unlock()
            }
            self.emit(sampleBuffer, captureMs: captureMs, encodeStartMs: encodeStartMs, input: input)
        }
    }

    private func emit(_ sample: CMSampleBuffer, captureMs: Double, encodeStartMs: Double, input: InputTag) {
        guard let block = CMSampleBufferGetDataBuffer(sample) else { return }
        var data = Data(count: CMBlockBufferGetDataLength(block))
        let copied = data.withUnsafeMutableBytes {
            CMBlockBufferCopyDataBytes(block, atOffset: 0, dataLength: $0.count, destination: $0.baseAddress!)
        }
        guard copied == noErr else { return }

        let attachments = CMSampleBufferGetSampleAttachmentsArray(sample, createIfNecessary: false) as? [[CFString: Any]]
        let isKeyframe = !(attachments?.first?[kCMSampleAttachmentKey_NotSync] as? Bool ?? false)
        let config = isKeyframe ? CMSampleBufferGetFormatDescription(sample).flatMap(streamConfig) : nil

        seq &+= 1
        let encodedMs = Clock.ms()
        statsLock.lock()
        stats.frames += 1
        encodedTotal += 1
        stats.bytes += data.count
        stats.keyframes += isKeyframe ? 1 : 0
        stats.maxBytes = max(stats.maxBytes, data.count)
        stats.encodeMs += encodedMs - encodeStartMs
        stats.queueMs += encodeStartMs - captureMs
        statsLock.unlock()
        onFrame?(EncodedFrame(
            seq: seq, data: data, isKeyframe: isKeyframe, config: config,
            captureMs: captureMs, encodeStartMs: encodeStartMs, encodedMs: encodedMs, input: input))
    }

    private func streamConfig(_ format: CMFormatDescription) -> StreamConfig? {
        let atoms = CMFormatDescriptionGetExtension(
            format, extensionKey: kCMFormatDescriptionExtension_SampleDescriptionExtensionAtoms) as? [String: Any]
        guard let avcC = atoms?["avcC"] as? Data, avcC.count > 4 else { return nil }
        let bytes = [UInt8](avcC)
        let codec = String(format: "avc1.%02x%02x%02x", bytes[1], bytes[2], bytes[3])
        let dims = CMVideoFormatDescriptionGetDimensions(format)
        return StreamConfig(codec: codec, width: Int(dims.width), height: Int(dims.height), description: avcC)
    }
}
