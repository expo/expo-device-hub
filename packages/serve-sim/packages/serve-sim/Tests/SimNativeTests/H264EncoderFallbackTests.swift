import CoreVideo
import VideoToolbox
import XCTest
@testable import SimNative

/// The encoder falls back from low-latency to default rate control once, after its first failed
/// encode, and counts it.
final class H264EncoderFallbackTests: XCTestCase {
    private let width = 320
    private let height = 640

    /// Flat gray in the default format; a depth format VideoToolbox cannot encode as H.264.
    private func frame(format: OSType = kCVPixelFormatType_420YpCbCr8BiPlanarVideoRange) throws -> CVPixelBuffer {
        var buffer: CVPixelBuffer?
        let attributes: [String: Any] = [kCVPixelBufferIOSurfacePropertiesKey as String: [:]]
        XCTAssertEqual(CVPixelBufferCreate(kCFAllocatorDefault, width, height, format,
                                           attributes as CFDictionary, &buffer), kCVReturnSuccess)
        let pixels = try XCTUnwrap(buffer)
        guard format == kCVPixelFormatType_420YpCbCr8BiPlanarVideoRange else { return pixels }
        CVPixelBufferLockBaseAddress(pixels, [])
        defer { CVPixelBufferUnlockBaseAddress(pixels, []) }
        for plane in 0..<2 {
            memset(CVPixelBufferGetBaseAddressOfPlane(pixels, plane), 128,
                   CVPixelBufferGetBytesPerRowOfPlane(pixels, plane) * CVPixelBufferGetHeightOfPlane(pixels, plane))
        }
        return pixels
    }

    private func requireLowLatencyRateControl() throws {
        var session: VTCompressionSession?
        let spec = [kVTVideoEncoderSpecification_EnableLowLatencyRateControl: kCFBooleanTrue!] as CFDictionary
        let status = VTCompressionSessionCreate(
            allocator: nil, width: Int32(width), height: Int32(height), codecType: kCMVideoCodecType_H264,
            encoderSpecification: spec, imageBufferAttributes: nil, compressedDataAllocator: nil,
            outputCallback: nil, refcon: nil, compressionSessionOut: &session
        )
        guard status == noErr, let session else { throw XCTSkip("no low-latency H.264 encoder here") }
        VTCompressionSessionInvalidate(session)
    }

    private func makeEncoder() -> H264Encoder {
        H264Encoder(fps: 60, bitrate: 500_000, constrainedBaseline: true, dynamicBitrate: true)
    }

    func testEncodeFailureCountsOneFallback() async throws {
        try requireLowLatencyRateControl()
        let encoder = makeEncoder()
        let depth = try frame(format: kCVPixelFormatType_DepthFloat32)
        for _ in 0..<3 {
            _ = try? await encoder.encode(depth)
        }
        let fallbacks = await encoder.lowLatencyFallbacks
        XCTAssertEqual(fallbacks, 1)
    }

    /// On Apple silicon hosts VideoToolbox drops the second frame of a low-latency session (noErr,
    /// no sample, kVTEncodeInfo_FrameDropped). The encoder takes the drop for a failure: it falls
    /// back once, counts it, and sends that frame as a keyframe.
    func testDroppedSecondFrameFallsBackOnce() async throws {
        try requireLowLatencyRateControl()
        let encoder = makeEncoder()
        let flat = try frame()
        _ = try await encoder.encode(flat)
        let second = try await encoder.encode(flat)
        if second.kind == .delta { throw XCTSkip("VideoToolbox kept the second frame on this host") }
        for _ in 0..<5 {
            _ = try await encoder.encode(flat)
        }
        let fallbacks = await encoder.lowLatencyFallbacks
        XCTAssertEqual(fallbacks, 1)
    }
}
