import Accelerate
import CoreImage
import CoreVideo
import Metal
import StreamingPolicy
import VideoToolbox

struct Dimensions: Hashable, Sendable {
    var width: Int
    var height: Int
}

extension CVPixelBuffer {
    var dimensions: Dimensions {
        Dimensions(width: CVPixelBufferGetWidth(self), height: CVPixelBufferGetHeight(self))
    }
}

struct Photocopier {
    /// Video range, because that is what the transfer session writes. Labelling the pool full
    /// range makes the decoder stretch 16-235 across 0-255 and blows out the highlights.
    private static let pixelFormat = kCVPixelFormatType_420YpCbCr8BiPlanarVideoRange
    private var _pool: CVPixelBufferPool?
    private var dimensions: Dimensions?
    private var _plainPool: CVPixelBufferPool?
    private var plainDimensions: Dimensions?
    private var plainFormat: OSType = 0
    private var transfer: VTPixelTransferSession?
    private var transferUnavailable = false
    private var nativeContext: CIContext?
    private var nativeContextUnavailable = false
    private(set) var cpuFallbacks: UInt64 = 0
    private(set) var poolDrops: UInt64 = 0

    init(useMetal: Bool = true, useTransfer: Bool = true) {
        nativeContextUnavailable = !useMetal
        transferUnavailable = !useTransfer
    }

    static func target(for source: CVPixelBuffer, maxDimension: Int) -> Dimensions {
        let size = source.dimensions
        let policy = SnapshotSizePolicy(
            width: size.width, height: size.height, maxDimension: maxDimension
        )
        return Dimensions(width: policy.width, height: policy.height)
    }

    private mutating func plainPool(dimensions: Dimensions, format: OSType) -> CVPixelBufferPool? {
        if let _plainPool, plainDimensions == dimensions, plainFormat == format { return _plainPool }
        let attrs: [String: Any] = [
            kCVPixelBufferPixelFormatTypeKey as String: format,
            kCVPixelBufferWidthKey as String: dimensions.width,
            kCVPixelBufferHeightKey as String: dimensions.height,
            kCVPixelBufferIOSurfacePropertiesKey as String: [:],
        ]
        var newPool: CVPixelBufferPool?
        CVPixelBufferPoolCreate(kCFAllocatorDefault, nil, attrs as CFDictionary, &newPool)
        _plainPool = newPool
        plainDimensions = dimensions
        plainFormat = format
        return newPool
    }

    private mutating func pool(dimensions: Dimensions) -> CVPixelBufferPool? {
        if let _pool, self.dimensions == dimensions { return _pool }
        let attrs: [String: Any] = [
            kCVPixelBufferPixelFormatTypeKey as String: Self.pixelFormat,
            kCVPixelBufferWidthKey as String: Int(dimensions.width),
            kCVPixelBufferHeightKey as String: Int(dimensions.height),
            kCVPixelBufferIOSurfacePropertiesKey as String: [:],
        ]
        var newPool: CVPixelBufferPool?
        CVPixelBufferPoolCreate(kCFAllocatorDefault, nil, attrs as CFDictionary, &newPool)
        self._pool = newPool
        self.dimensions = dimensions
        return newPool
    }

    private mutating func transferSession() -> VTPixelTransferSession? {
        if let transfer { return transfer }
        // A host without a usable GPU transfer fails every time. Retrying per frame would be
        // 60 session creations a second on exactly the host that can least afford them.
        if transferUnavailable { return nil }
        var session: VTPixelTransferSession?
        guard VTPixelTransferSessionCreate(allocator: kCFAllocatorDefault,
                                           pixelTransferSessionOut: &session) == noErr,
              let session else {
            transferUnavailable = true
            print("[capture] GPU pixel transfer unavailable; falling back to CPU copies")
            return nil
        }
        VTSessionSetProperty(session,
                             key: kVTPixelTransferPropertyKey_ScalingMode,
                             value: kVTScalingMode_Normal)
        transfer = session
        return session
    }

    /// Snapshot `source` (which wraps the recycled framebuffer IOSurface) into a private
    /// pooled buffer that sinks can retain.
    ///
    /// The transfer runs on the GPU. Locking the framebuffer for a CPU copy instead means
    /// waiting for the compositor's writes to be made visible to the CPU, which is where
    /// this stalled for hundreds of milliseconds during full-screen transitions.
    mutating func copy(_ source: CVPixelBuffer, maxDimension: Int = 0) -> CVPixelBuffer? {
        let target = Self.target(for: source, maxDimension: maxDimension)
        let sourceSize = source.dimensions
        if target != sourceSize,
           target.width >= sourceSize.width, target.height >= sourceSize.height,
           maxDimension <= 0 || max(sourceSize.width, sourceSize.height) <= maxDimension {
            return copyOddNative(source, target: target)
        }
        guard let pool = self.pool(dimensions: target)
        else { return nil }
        guard let dst = Self.buffer(from: pool) else {
            poolDrops &+= 1
            return nil
        }

        if let session = transferSession(),
           VTPixelTransferSessionTransferImage(session, from: source, to: dst) == noErr {
            return dst
        }
        let format = CVPixelBufferGetPixelFormatType(source)
        if format == kCVPixelFormatType_32BGRA, target != sourceSize,
           (target.width < sourceSize.width || target.height < sourceSize.height) {
            guard let plain = plainPool(dimensions: target, format: format),
                  let out = Self.buffer(from: plain) else {
                poolDrops &+= 1
                return nil
            }
            guard Self.scaleOnCPU(source, into: out) else { return nil }
            cpuFallbacks &+= 1
            return out
        }
        // If conversion failed but the frame needs no downscale, keep a same-size
        // owned copy in its original format for the downstream consumers.
        guard let plain = plainPool(dimensions: source.dimensions, format: format) else { return nil }
        guard let out = Self.buffer(from: plain) else {
            poolDrops &+= 1
            return nil
        }
        guard Self.copyOnCPU(source, into: out) else { return nil }
        cpuFallbacks += 1
        return out
    }

    private mutating func copyOddNative(_ source: CVPixelBuffer,
                                        target: Dimensions) -> CVPixelBuffer? {
        guard CVPixelBufferGetPixelFormatType(source) == kCVPixelFormatType_32BGRA else { return nil }
        guard let pool = plainPool(dimensions: target, format: kCVPixelFormatType_32BGRA),
              let output = Self.buffer(from: pool) else {
            poolDrops &+= 1
            return nil
        }
        if nativeContext == nil, !nativeContextUnavailable {
            if let device = MTLCreateSystemDefaultDevice() {
                nativeContext = CIContext(mtlDevice: device,
                                          options: [.workingColorSpace: NSNull(),
                                                    .outputColorSpace: NSNull()])
            } else {
                nativeContextUnavailable = true
                print("[capture] Metal native-size copy unavailable; using CPU copy")
            }
        }
        guard let nativeContext else {
            guard Self.copyOddOnCPU(source, into: output) else { return nil }
            cpuFallbacks &+= 1
            return output
        }
        nativeContext.render(CIImage(cvPixelBuffer: source)
                                 .transformed(by: CGAffineTransform(
                                    translationX: 0,
                                    y: CGFloat(target.height - source.dimensions.height))),
                             to: output,
                             bounds: CGRect(x: 0, y: 0, width: target.width,
                                            height: target.height), colorSpace: nil)
        return output
    }

    private static func copyOddOnCPU(_ source: CVPixelBuffer, into output: CVPixelBuffer) -> Bool {
        let sourceSize = source.dimensions
        let target = output.dimensions
        guard sourceSize.width <= target.width, sourceSize.height <= target.height,
              CVPixelBufferGetPixelFormatType(source) == kCVPixelFormatType_32BGRA,
              CVPixelBufferGetPixelFormatType(output) == kCVPixelFormatType_32BGRA,
              CVPixelBufferLockBaseAddress(source, .readOnly) == kCVReturnSuccess else { return false }
        defer { CVPixelBufferUnlockBaseAddress(source, .readOnly) }
        guard CVPixelBufferLockBaseAddress(output, []) == kCVReturnSuccess else { return false }
        defer { CVPixelBufferUnlockBaseAddress(output, []) }
        guard let src = CVPixelBufferGetBaseAddress(source),
              let dst = CVPixelBufferGetBaseAddress(output) else { return false }
        let sourceStride = CVPixelBufferGetBytesPerRow(source)
        let targetStride = CVPixelBufferGetBytesPerRow(output)
        memset(dst, 0, targetStride * target.height)
        for row in 0..<sourceSize.height {
            memcpy(dst + row * targetStride, src + row * sourceStride, sourceSize.width * 4)
        }
        return true
    }

    mutating func reset() {
        if let transfer { VTPixelTransferSessionInvalidate(transfer) }
        transfer = nil
        transferUnavailable = false
        _pool = nil
        dimensions = nil
        _plainPool = nil
        plainDimensions = nil
        plainFormat = 0
        nativeContext = nil
        nativeContextUnavailable = false
    }

    private static func buffer(from pool: CVPixelBufferPool) -> CVPixelBuffer? {
        var out: CVPixelBuffer?
        guard CVPixelBufferPoolCreatePixelBuffer(kCFAllocatorDefault, pool, &out) == kCVReturnSuccess
        else { return nil }
        return out
    }

    /// Only reached if the GPU transfer fails. Planar buffers have a NULL base address, so
    /// reading one as packed would drop every frame.
    private static func copyOnCPU(_ source: CVPixelBuffer, into dst: CVPixelBuffer) -> Bool {
        guard source.dimensions == dst.dimensions,
              CVPixelBufferGetPixelFormatType(source) == CVPixelBufferGetPixelFormatType(dst)
        else { return false }
        CVPixelBufferLockBaseAddress(source, .readOnly)
        CVPixelBufferLockBaseAddress(dst, [])
        defer {
            CVPixelBufferUnlockBaseAddress(dst, [])
            CVPixelBufferUnlockBaseAddress(source, .readOnly)
        }
        let planes = max(1, CVPixelBufferGetPlaneCount(source))
        let planar = CVPixelBufferIsPlanar(source)
        for plane in 0..<planes {
            let srcAddr = planar
                ? CVPixelBufferGetBaseAddressOfPlane(source, plane)
                : CVPixelBufferGetBaseAddress(source)
            let dstAddr = planar
                ? CVPixelBufferGetBaseAddressOfPlane(dst, plane)
                : CVPixelBufferGetBaseAddress(dst)
            guard let srcAddr, let dstAddr else { return false }
            let srcStride = planar
                ? CVPixelBufferGetBytesPerRowOfPlane(source, plane)
                : CVPixelBufferGetBytesPerRow(source)
            let dstStride = planar
                ? CVPixelBufferGetBytesPerRowOfPlane(dst, plane)
                : CVPixelBufferGetBytesPerRow(dst)
            let rows = planar
                ? CVPixelBufferGetHeightOfPlane(source, plane)
                : CVPixelBufferGetHeight(source)
            let bytes = min(srcStride, dstStride)
            for row in 0..<rows {
                memcpy(dstAddr + row * dstStride, srcAddr + row * srcStride, bytes)
            }
        }
        return true
    }

    private static func scaleOnCPU(_ source: CVPixelBuffer, into dst: CVPixelBuffer) -> Bool {
        guard CVPixelBufferGetPixelFormatType(source) == kCVPixelFormatType_32BGRA,
              CVPixelBufferGetPixelFormatType(dst) == kCVPixelFormatType_32BGRA,
              CVPixelBufferLockBaseAddress(source, .readOnly) == kCVReturnSuccess else { return false }
        defer { CVPixelBufferUnlockBaseAddress(source, .readOnly) }
        guard CVPixelBufferLockBaseAddress(dst, []) == kCVReturnSuccess else { return false }
        defer { CVPixelBufferUnlockBaseAddress(dst, []) }
        guard let sourceAddress = CVPixelBufferGetBaseAddress(source),
              let targetAddress = CVPixelBufferGetBaseAddress(dst) else { return false }
        var input = vImage_Buffer(data: sourceAddress,
                                  height: vImagePixelCount(CVPixelBufferGetHeight(source)),
                                  width: vImagePixelCount(CVPixelBufferGetWidth(source)),
                                  rowBytes: CVPixelBufferGetBytesPerRow(source))
        var output = vImage_Buffer(data: targetAddress,
                                   height: vImagePixelCount(CVPixelBufferGetHeight(dst)),
                                   width: vImagePixelCount(CVPixelBufferGetWidth(dst)),
                                   rowBytes: CVPixelBufferGetBytesPerRow(dst))
        return vImageScale_ARGB8888(&input, &output, nil,
                                    vImage_Flags(kvImageNoFlags)) == kvImageNoError
    }
}
