import CoreMedia
import CoreVideo
import StreamingPolicy
import VideoToolbox
import XCTest
@testable import SimNative

/// The HTTP AVCC description declares zero reordering in default rate control, and a real
/// decoder accepts it.
final class H264EncoderDecoderConfigTests: XCTestCase {
    func testDefaultModeDescriptionDeclaresZeroReorder() async throws {
        let encoder = H264Encoder(fps: 60, bitrate: 500_000, lowLatencyRateControl: false)
        let output = try await encoder.encode(try frame(), forceKeyframe: true)
        await encoder.stop()
        let description = try XCTUnwrap(output.description)
        let (sps, pps) = try parameterSets(avcC: description)
        let original = try XCTUnwrap(output.parameterSets.first, "VideoToolbox's unmodified SPS")
        if H264SPSReorderLimit.addingZeroReorder(to: original) == original {
            throw XCTSkip("VideoToolbox already declared reordering, or used an SPS layout the rewrite skips")
        }
        XCTAssertEqual(sps, H264SPSReorderLimit.addingZeroReorder(to: original))
        XCTAssertGreaterThan(sps.count, original.count)
        XCTAssertEqual(pps, output.parameterSets.last)
        XCTAssertFalse(nalTypes(avcc: output.avcc).contains(7), "an in-band SPS would contradict the description")
        try decode(output.avcc, sps: sps, pps: pps)
    }

    func testLowLatencyDescriptionIsUnchanged() async throws {
        let encoder = H264Encoder(fps: 60, bitrate: 500_000)
        let output = try await encoder.encode(try frame(), forceKeyframe: true)
        let fallbacks = await encoder.lowLatencyFallbacks
        await encoder.stop()
        guard fallbacks == 0 else { throw XCTSkip("no low-latency H.264 encoder here") }
        let (sps, _) = try parameterSets(avcC: try XCTUnwrap(output.description))
        XCTAssertEqual(sps, output.parameterSets.first)
    }

    private func frame() throws -> CVPixelBuffer {
        var buffer: CVPixelBuffer?
        let attributes: [String: Any] = [kCVPixelBufferIOSurfacePropertiesKey as String: [:]]
        XCTAssertEqual(CVPixelBufferCreate(kCFAllocatorDefault, 320, 640,
                                           kCVPixelFormatType_420YpCbCr8BiPlanarVideoRange,
                                           attributes as CFDictionary, &buffer), kCVReturnSuccess)
        let pixels = try XCTUnwrap(buffer)
        CVPixelBufferLockBaseAddress(pixels, [])
        defer { CVPixelBufferUnlockBaseAddress(pixels, []) }
        for plane in 0..<2 {
            memset(CVPixelBufferGetBaseAddressOfPlane(pixels, plane), 128,
                   CVPixelBufferGetBytesPerRowOfPlane(pixels, plane) * CVPixelBufferGetHeightOfPlane(pixels, plane))
        }
        return pixels
    }

    /// Reads the single SPS and PPS of an avcC record as `H264Encoder` writes it.
    private func parameterSets(avcC: Data) throws -> (Data, Data) {
        let bytes = [UInt8](avcC)
        XCTAssertEqual(bytes[5] & 0x1f, 1)
        let spsLength = Int(bytes[6]) << 8 | Int(bytes[7])
        let ppsStart = 8 + spsLength
        XCTAssertEqual(bytes[ppsStart], 1)
        let ppsLength = Int(bytes[ppsStart + 1]) << 8 | Int(bytes[ppsStart + 2])
        XCTAssertEqual(bytes.count, ppsStart + 3 + ppsLength)
        return (Data(bytes[8..<ppsStart]), Data(bytes[(ppsStart + 3)...]))
    }

    private func nalTypes(avcc: Data) -> [UInt8] {
        let bytes = [UInt8](avcc)
        var types: [UInt8] = []
        var index = 0
        while index + 4 < bytes.count {
            let length = bytes[index..<index + 4].reduce(0) { $0 << 8 | Int($1) }
            types.append(bytes[index + 4] & 0x1f)
            index += 4 + length
        }
        return types
    }

    private func decode(_ avcc: Data, sps: Data, pps: Data) throws {
        var format: CMVideoFormatDescription?
        let status = sps.withUnsafeBytes { spsBytes in
            pps.withUnsafeBytes { ppsBytes in
                let pointers = [spsBytes.bindMemory(to: UInt8.self).baseAddress!,
                                ppsBytes.bindMemory(to: UInt8.self).baseAddress!]
                return CMVideoFormatDescriptionCreateFromH264ParameterSets(
                    allocator: nil, parameterSetCount: 2, parameterSetPointers: pointers,
                    parameterSetSizes: [sps.count, pps.count], nalUnitHeaderLength: 4,
                    formatDescriptionOut: &format)
            }
        }
        XCTAssertEqual(status, noErr)
        let formatDescription = try XCTUnwrap(format)

        var session: VTDecompressionSession?
        XCTAssertEqual(VTDecompressionSessionCreate(
            allocator: nil, formatDescription: formatDescription, decoderSpecification: nil,
            imageBufferAttributes: nil, outputCallback: nil, decompressionSessionOut: &session), noErr)
        let decoder = try XCTUnwrap(session)
        defer { VTDecompressionSessionInvalidate(decoder) }

        var block: CMBlockBuffer?
        XCTAssertEqual(CMBlockBufferCreateWithMemoryBlock(
            allocator: nil, memoryBlock: nil, blockLength: avcc.count, blockAllocator: nil,
            customBlockSource: nil, offsetToData: 0, dataLength: avcc.count, flags: 0,
            blockBufferOut: &block), noErr)
        let blockBuffer = try XCTUnwrap(block)
        avcc.withUnsafeBytes { bytes in
            _ = CMBlockBufferReplaceDataBytes(with: bytes.baseAddress!, blockBuffer: blockBuffer,
                                              offsetIntoDestination: 0, dataLength: avcc.count)
        }
        var sample: CMSampleBuffer?
        XCTAssertEqual(CMSampleBufferCreateReady(
            allocator: nil, dataBuffer: blockBuffer, formatDescription: formatDescription,
            sampleCount: 1, sampleTimingEntryCount: 0, sampleTimingArray: nil,
            sampleSizeEntryCount: 1, sampleSizeArray: [avcc.count], sampleBufferOut: &sample), noErr)

        var decodeStatus: OSStatus = -1
        var decoded: CVImageBuffer?
        XCTAssertEqual(VTDecompressionSessionDecodeFrame(
            decoder, sampleBuffer: try XCTUnwrap(sample), flags: [], infoFlagsOut: nil
        ) { status, _, imageBuffer, _, _ in
            decodeStatus = status
            decoded = imageBuffer
        }, noErr)
        VTDecompressionSessionWaitForAsynchronousFrames(decoder)
        XCTAssertEqual(decodeStatus, noErr)
        XCTAssertEqual(decoded.map(CVPixelBufferGetWidth), 320)
    }
}
