import CoreMedia
import CoreVideo
import Foundation
import VideoToolbox

final class HEVCDecoder {
    var onFrame: (CVPixelBuffer) -> Void = { _ in }
    var onFailure: (String) -> Void = { _ in }
    var onConfiguration: (String) -> Void = { _ in }

    private(set) var needsKeyframe = true
    private var parameterSets: [UInt8: Data] = [:]
    private var format: CMVideoFormatDescription?
    private var session: VTDecompressionSession?
    private var discardingLeadingPictures = false

    deinit {
        if let session { VTDecompressionSessionInvalidate(session) }
    }

    func invalidate() {
        needsKeyframe = true
        if let session { VTDecompressionSessionInvalidate(session) }
        session = nil
    }

    func decode(_ nals: [Data], timestamp: UInt32) {
        var picture: [Data] = []
        var randomAccess = false
        var parameterSetsChanged = false
        var sliceTypes: [UInt8] = []

        for nal in nals {
            guard nal.count >= 2 else { continue }
            let type = (nal[nal.startIndex] >> 1) & 63
            if (32...34).contains(type) {
                if parameterSets[type] != nal {
                    parameterSets[type] = nal
                    parameterSetsChanged = true
                }
            } else {
                picture.append(nal)
                if type < 32 { sliceTypes.append(type) }
                if (16...21).contains(type) { randomAccess = true }
            }
        }

        if parameterSetsChanged {
            invalidate()
            format = nil
        }
        guard !sliceTypes.isEmpty else { return }
        guard !needsKeyframe || randomAccess else { return }
        if discardingLeadingPictures, sliceTypes.contains(where: { $0 == 8 || $0 == 9 }) { return }
        if needsKeyframe, randomAccess {
            discardingLeadingPictures = true
        } else if sliceTypes.contains(where: { $0 < 6 }) {
            discardingLeadingPictures = false
        }

        do {
            if session == nil { try configure() }
            guard let session, let format else { return }
            let sample = try compressedSample(
                picture: picture,
                timestamp: timestamp,
                format: format,
                randomAccess: randomAccess
            )
            try decodeSample(sample, with: session)
        } catch {
            invalidate()
            onFailure("\(error)")
        }
    }

    private func compressedSample(
        picture: [Data],
        timestamp: UInt32,
        format: CMVideoFormatDescription,
        randomAccess: Bool
    ) throws -> CMSampleBuffer {
        var bytes = Data()
        for nal in picture {
            bytes.append(contentsOf: HEVCRTPReceiver.word(UInt32(nal.count)))
            bytes.append(nal)
        }

        var block: CMBlockBuffer?
        try checked(
            CMBlockBufferCreateWithMemoryBlock(
                allocator: kCFAllocatorDefault,
                memoryBlock: nil,
                blockLength: bytes.count,
                blockAllocator: kCFAllocatorDefault,
                customBlockSource: nil,
                offsetToData: 0,
                dataLength: bytes.count,
                flags: 0,
                blockBufferOut: &block
            ),
            "block allocation"
        )
        guard let block else { throw CoreDeviceMediaStreamError("no block buffer") }
        try bytes.withUnsafeBytes { raw in
            try checked(
                CMBlockBufferReplaceDataBytes(
                    with: raw.baseAddress!,
                    blockBuffer: block,
                    offsetIntoDestination: 0,
                    dataLength: bytes.count
                ),
                "block copy"
            )
        }

        var timing = CMSampleTimingInfo(
            duration: .invalid,
            presentationTimeStamp: CMTime(value: Int64(timestamp), timescale: 90_000),
            decodeTimeStamp: .invalid
        )
        var sizes = [bytes.count]
        var sample: CMSampleBuffer?
        try checked(
            CMSampleBufferCreateReady(
                allocator: kCFAllocatorDefault,
                dataBuffer: block,
                formatDescription: format,
                sampleCount: 1,
                sampleTimingEntryCount: 1,
                sampleTimingArray: &timing,
                sampleSizeEntryCount: 1,
                sampleSizeArray: &sizes,
                sampleBufferOut: &sample
            ),
            "compressed sample"
        )
        guard let sample else { throw CoreDeviceMediaStreamError("no sample buffer") }

        if let attachments = CMSampleBufferGetSampleAttachmentsArray(sample, createIfNecessary: true) {
            let dictionary = unsafeBitCast(
                CFArrayGetValueAtIndex(attachments, 0),
                to: CFMutableDictionary.self
            )
            let dependsOnOthers = randomAccess ? kCFBooleanFalse! : kCFBooleanTrue!
            CFDictionarySetValue(
                dictionary,
                Unmanaged.passUnretained(kCMSampleAttachmentKey_NotSync).toOpaque(),
                Unmanaged.passUnretained(dependsOnOthers).toOpaque()
            )
            CFDictionarySetValue(
                dictionary,
                Unmanaged.passUnretained(kCMSampleAttachmentKey_DependsOnOthers).toOpaque(),
                Unmanaged.passUnretained(dependsOnOthers).toOpaque()
            )
        }
        return sample
    }

    private func decodeSample(
        _ sample: CMSampleBuffer,
        with session: VTDecompressionSession
    ) throws {
        let status = VTDecompressionSessionDecodeFrame(
            session,
            sampleBuffer: sample,
            flags: [],
            infoFlagsOut: nil
        ) { status, _, image, _, _ in
            if status != noErr { self.onFailure("decode failed with OSStatus \(status)") }
            guard let image else { return }
            self.needsKeyframe = false
            self.onFrame(image)
        }
        try checked(status, "decode submission")
    }

    private func configure() throws {
        guard let vps = parameterSets[32], let sps = parameterSets[33], let pps = parameterSets[34] else {
            throw CoreDeviceMediaStreamError("no parameter sets yet")
        }
        let status = vps.withUnsafeBytes { v in
            sps.withUnsafeBytes { s in
                pps.withUnsafeBytes { p in
                    let pointers = [
                        v.bindMemory(to: UInt8.self).baseAddress!,
                        s.bindMemory(to: UInt8.self).baseAddress!,
                        p.bindMemory(to: UInt8.self).baseAddress!,
                    ]
                    return CMVideoFormatDescriptionCreateFromHEVCParameterSets(
                        allocator: kCFAllocatorDefault,
                        parameterSetCount: 3,
                        parameterSetPointers: pointers,
                        parameterSetSizes: [vps.count, sps.count, pps.count],
                        nalUnitHeaderLength: 4,
                        extensions: nil,
                        formatDescriptionOut: &format
                    )
                }
            }
        }
        try checked(status, "HEVC format")
        guard let format else { throw CoreDeviceMediaStreamError("no format description") }

        let specification: [CFString: Any] = [
            kVTVideoDecoderSpecification_EnableHardwareAcceleratedVideoDecoder: true,
        ]
        try checked(
            VTDecompressionSessionCreate(
                allocator: kCFAllocatorDefault,
                formatDescription: format,
                decoderSpecification: specification as CFDictionary,
                imageBufferAttributes: [kCVPixelBufferIOSurfacePropertiesKey: [:]] as CFDictionary,
                outputCallback: nil,
                decompressionSessionOut: &session
            ),
            "decoder creation"
        )
        guard let session else { throw CoreDeviceMediaStreamError("no decompression session") }
        VTSessionSetProperty(session, key: kVTDecompressionPropertyKey_RealTime, value: kCFBooleanTrue)
        var usingHardware: Unmanaged<CFTypeRef>?
        let hardwareStatus = VTSessionCopyProperty(
            session,
            key: kVTDecompressionPropertyKey_UsingHardwareAcceleratedVideoDecoder,
            allocator: kCFAllocatorDefault,
            valueOut: &usingHardware
        )
        if hardwareStatus == 0, let enabled = usingHardware?.takeRetainedValue() as? Bool {
            onConfiguration("HEVC decoder: \(enabled ? "hardware" : "software")")
        }
    }

    private func checked(_ status: OSStatus, _ operation: String) throws {
        guard status != 0 else { return }
        throw CoreDeviceMediaStreamError("\(operation): OSStatus \(status)")
    }
}
