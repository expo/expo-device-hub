import CoreMedia
import CoreVideo
import Foundation
import VideoToolbox

/// Decodes each encoded frame and computes luma PSNR against the exact source frame, so encoder
/// settings can be judged on real motion rather than on a settled screenshot. Diagnostic only.
final class QualityProbe {
    private var session: VTDecompressionSession?
    private var format: CMFormatDescription?

    func measure(_ sample: CMSampleBuffer, against source: CVPixelBuffer) -> Double? {
        guard let fmt = CMSampleBufferGetFormatDescription(sample) else { return nil }
        if session == nil || format.map({ !CMFormatDescriptionEqual($0, otherFormatDescription: fmt) }) ?? true {
            if let session { VTDecompressionSessionInvalidate(session) }
            let attrs: [CFString: Any] = [kCVPixelBufferPixelFormatTypeKey: CVPixelBufferGetPixelFormatType(source)]
            var created: VTDecompressionSession?
            guard VTDecompressionSessionCreate(allocator: nil, formatDescription: fmt, decoderSpecification: nil,
                                               imageBufferAttributes: attrs as CFDictionary, outputCallback: nil,
                                               decompressionSessionOut: &created) == noErr else { return nil }
            session = created
            format = fmt
        }
        guard let session else { return nil }

        var decoded: CVPixelBuffer?
        VTDecompressionSessionDecodeFrame(session, sampleBuffer: sample, flags: [], infoFlagsOut: nil) { status, _, image, _, _ in
            if status == noErr { decoded = image }
        }
        VTDecompressionSessionWaitForAsynchronousFrames(session)
        guard let decoded else { return nil }
        return Self.lumaPSNR(source, decoded)
    }

    private static func lumaPSNR(_ a: CVPixelBuffer, _ b: CVPixelBuffer) -> Double? {
        CVPixelBufferLockBaseAddress(a, .readOnly)
        CVPixelBufferLockBaseAddress(b, .readOnly)
        defer {
            CVPixelBufferUnlockBaseAddress(a, .readOnly)
            CVPixelBufferUnlockBaseAddress(b, .readOnly)
        }
        let width = CVPixelBufferGetWidthOfPlane(a, 0), height = CVPixelBufferGetHeightOfPlane(a, 0)
        guard width == CVPixelBufferGetWidthOfPlane(b, 0), height == CVPixelBufferGetHeightOfPlane(b, 0),
              let pa = CVPixelBufferGetBaseAddressOfPlane(a, 0), let pb = CVPixelBufferGetBaseAddressOfPlane(b, 0)
        else { return nil }
        let strideA = CVPixelBufferGetBytesPerRowOfPlane(a, 0), strideB = CVPixelBufferGetBytesPerRowOfPlane(b, 0)
        var sum: UInt64 = 0
        for y in 0..<height {
            let ra = pa.advanced(by: y * strideA).assumingMemoryBound(to: UInt8.self)
            let rb = pb.advanced(by: y * strideB).assumingMemoryBound(to: UInt8.self)
            var row: UInt32 = 0
            for x in 0..<width {
                let d = Int32(ra[x]) - Int32(rb[x])
                row &+= UInt32(d * d)
            }
            sum &+= UInt64(row)
        }
        let mse = Double(sum) / Double(width * height)
        return mse == 0 ? 99 : 10 * log10(255 * 255 / mse)
    }
}
