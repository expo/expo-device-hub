import CoreGraphics
import CoreVideo
import Foundation
import StreamingPolicy
import VideoToolbox

struct PhysicalFrameCopier {
    static let videoFormat = kCVPixelFormatType_420YpCbCr8BiPlanarVideoRange
    static let screenshotFormat = kCVPixelFormatType_32BGRA

    private struct PoolKey: Equatable {
        let format: OSType
        let width: Int
        let height: Int
    }

    private var transfer: VTPixelTransferSession?
    private var pools: [OSType: (key: PoolKey, pool: CVPixelBufferPool)] = [:]
    private(set) var poolDrops: UInt64 = 0

    static func target(content: PhysicalContentSize, maxDimension: Int) -> Dimensions {
        let policy = SnapshotSizePolicy(width: content.width, height: content.height, maxDimension: maxDimension)
        return Dimensions(width: policy.width, height: policy.height)
    }

    mutating func videoFrame(_ source: CVPixelBuffer, content: PhysicalContentSize, maxDimension: Int) -> CVPixelBuffer? {
        copy(source, content: content, into: Self.target(content: content, maxDimension: maxDimension), format: Self.videoFormat)
    }

    mutating func screenshot(_ source: CVPixelBuffer, content: PhysicalContentSize) -> CVPixelBuffer? {
        copy(source, content: content, into: Dimensions(width: content.width, height: content.height), format: Self.screenshotFormat)
    }

    mutating func reset() {
        if let transfer { VTPixelTransferSessionInvalidate(transfer) }
        transfer = nil
        pools.removeAll()
    }

    private mutating func copy(_ source: CVPixelBuffer, content: PhysicalContentSize, into size: Dimensions,
                               format: OSType) -> CVPixelBuffer? {
        guard content.width > 0, content.height > 0, size.width > 0, size.height > 0,
              let session = transferSession(),
              let pool = pool(PoolKey(format: format, width: size.width, height: size.height)) else { return nil }
        var output: CVPixelBuffer?
        guard CVPixelBufferPoolCreatePixelBuffer(kCFAllocatorDefault, pool, &output) == kCVReturnSuccess,
              let output else {
            poolDrops &+= 1
            return nil
        }
        // @ref LLP 0026#cropping-and-scaling — pixel transfer has no source crop; a clean aperture anchors the crop top-left.
        CVBufferSetAttachment(source, kCVImageBufferCleanApertureKey,
                              Self.cleanAperture(content: content, encoded: source.dimensions) as CFDictionary,
                              .shouldNotPropagate)
        guard VTPixelTransferSessionTransferImage(session, from: source, to: output) == noErr else { return nil }
        return output
    }

    static func cleanAperture(content: PhysicalContentSize, encoded: Dimensions) -> [CFString: Any] {
        [
            kCVImageBufferCleanApertureWidthKey: content.width,
            kCVImageBufferCleanApertureHeightKey: content.height,
            kCVImageBufferCleanApertureHorizontalOffsetKey: Double(content.width - encoded.width) / 2,
            kCVImageBufferCleanApertureVerticalOffsetKey: Double(content.height - encoded.height) / 2,
        ]
    }

    private mutating func transferSession() -> VTPixelTransferSession? {
        if let transfer { return transfer }
        var session: VTPixelTransferSession?
        guard VTPixelTransferSessionCreate(allocator: kCFAllocatorDefault, pixelTransferSessionOut: &session) == noErr,
              let session else { return nil }
        VTSessionSetProperty(session, key: kVTPixelTransferPropertyKey_ScalingMode,
                             value: kVTScalingMode_CropSourceToCleanAperture)
        transfer = session
        return session
    }

    private mutating func pool(_ key: PoolKey) -> CVPixelBufferPool? {
        if let existing = pools[key.format], existing.key == key { return existing.pool }
        var attributes: [String: Any] = [
            kCVPixelBufferPixelFormatTypeKey as String: key.format,
            kCVPixelBufferWidthKey as String: key.width,
            kCVPixelBufferHeightKey as String: key.height,
            kCVPixelBufferIOSurfacePropertiesKey as String: [:],
        ]
        if key.format == Self.videoFormat { attributes[kCVPixelBufferMetalCompatibilityKey as String] = true }
        var created: CVPixelBufferPool?
        guard CVPixelBufferPoolCreate(kCFAllocatorDefault, nil, attributes as CFDictionary, &created) == kCVReturnSuccess,
              let created else { return nil }
        pools[key.format] = (key, created)
        return created
    }
}
