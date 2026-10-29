import Accelerate
import CoreVideo
import Foundation
import StreamingPolicy
import VideoToolbox

final class PixelBufferLetterboxer {
    private let allowCPUFallback: Bool
    private let allocationLimit: CFDictionary?
    private var pool: CVPixelBufferPool?
    private var poolWidth = 0
    private var poolHeight = 0
    private var poolFormat: OSType = 0
    private var transfer: VTPixelTransferSession?
    private var transferUnavailable = false
    private(set) var transferFrames: UInt64 = 0
    private(set) var cpuFrames: UInt64 = 0
    private(set) var poolDrops: UInt64 = 0
    typealias TransferImage = (VTPixelTransferSession, CVPixelBuffer, CVPixelBuffer) -> OSStatus
    private let transferImage: TransferImage

    /// `preferCPU` skips the VideoToolbox transfer and scales with vImage from the start.
    /// `transferImage` lets a test fail the VideoToolbox transfer.
    init(allowCPUFallback: Bool = true, maxBuffers: Int? = nil, preferCPU: Bool = false,
         transferImage: @escaping TransferImage = { VTPixelTransferSessionTransferImage($0, from: $1, to: $2) }) {
        self.allowCPUFallback = allowCPUFallback
        self.transferImage = transferImage
        allocationLimit = maxBuffers.map { [kCVPixelBufferPoolAllocationThresholdKey as String: $0] as CFDictionary }
        transferUnavailable = preferCPU && allowCPUFallback
    }

    static func supports(_ format: OSType) -> Bool {
        [kCVPixelFormatType_32BGRA,
         kCVPixelFormatType_420YpCbCr8BiPlanarVideoRange,
         kCVPixelFormatType_420YpCbCr8BiPlanarFullRange].contains(format)
    }

    /// `topLeft` uses the live viewer placement, ``LetterboxPlacement/topLeft(sourceWidth:sourceHeight:canvasWidth:canvasHeight:)``,
    /// instead of a centered picture.
    func place(_ source: CVPixelBuffer, width: Int, height: Int, topLeft: Bool = false) -> CVPixelBuffer? {
        let format = CVPixelBufferGetPixelFormatType(source)
        guard width > 0, height > 0, Self.supports(format) else { return nil }
        let sourceWidth = CVPixelBufferGetWidth(source)
        let sourceHeight = CVPixelBufferGetHeight(source)
        if sourceWidth == width, sourceHeight == height { return source }
        let placement = topLeft
            ? LetterboxPlacement.topLeft(sourceWidth: sourceWidth, sourceHeight: sourceHeight,
                                         canvasWidth: width, canvasHeight: height)
            : LetterboxPlacement(sourceWidth: sourceWidth, sourceHeight: sourceHeight,
                                 canvasWidth: width, canvasHeight: height)
        guard let output = makeOutput(width: width, height: height, format: format) else { return nil }

        if topLeft {
            // The plain letterbox mode always centers, so the aperture places the picture. A
            // top-left frame never uses the centered session, so a failure here falls to the CPU path.
            if !transferUnavailable {
                let geometry = PlacedGeometry(source: source.dimensions,
                                              canvas: Dimensions(width: width, height: height),
                                              placement: placement)
                if let transfer = placedSession(geometry),
                   transferImage(transfer, source, output) == noErr {
                    transferFrames &+= 1
                    for key in [kCVImageBufferCleanApertureKey, kCVImageBufferPreferredCleanApertureKey,
                                kCVImageBufferPixelAspectRatioKey] { CVBufferRemoveAttachment(output, key) }
                    Self.extendPictureEdges(output, placement: placement)
                    return output
                }
                if let placedTransfer { VTPixelTransferSessionInvalidate(placedTransfer) }
                placedTransfer = nil
                placedGeometry = nil
                placedTransferUnavailable = true
                transferUnavailable = true
                print("[stream] VideoToolbox letterbox transfer failed; \(allowCPUFallback ? "using CPU scaling" : "dropping frame")")
            }
        } else if let transfer = transferSession(),
           transferImage(transfer, source, output) == noErr {
            transferFrames &+= 1
            return output
        }
        if !topLeft, let transfer {
            VTPixelTransferSessionInvalidate(transfer)
            self.transfer = nil
            transferUnavailable = true
            print("[stream] VideoToolbox letterbox transfer failed; \(allowCPUFallback ? "using CPU scaling" : "dropping frame")")
        }
        guard allowCPUFallback else { return nil }
        cpuFrames &+= 1

        CVPixelBufferLockBaseAddress(source, .readOnly)
        CVPixelBufferLockBaseAddress(output, [])
        defer {
            CVPixelBufferUnlockBaseAddress(output, [])
            CVPixelBufferUnlockBaseAddress(source, .readOnly)
        }
        if format != kCVPixelFormatType_32BGRA {
            guard placeBiPlanar(source, into: output, placement: placement, format: format) else { return nil }
            if topLeft { Self.extendPictureEdges(output, placement: placement) }
            return output
        }
        guard let sourceAddress = CVPixelBufferGetBaseAddress(source),
              let outputAddress = CVPixelBufferGetBaseAddress(output) else { return nil }
        let outputStride = CVPixelBufferGetBytesPerRow(output)
        memset(outputAddress, 0, outputStride * height)
        var sourceImage = vImage_Buffer(
            data: sourceAddress, height: vImagePixelCount(sourceHeight),
            width: vImagePixelCount(sourceWidth), rowBytes: CVPixelBufferGetBytesPerRow(source)
        )
        var destination = vImage_Buffer(
            data: outputAddress.advanced(by: placement.y * outputStride + placement.x * 4),
            height: vImagePixelCount(placement.height), width: vImagePixelCount(placement.width),
            rowBytes: outputStride
        )
        guard vImageScale_ARGB8888(&sourceImage, &destination, nil,
                                   vImage_Flags(kvImageNoFlags)) == kvImageNoError else { return nil }
        if topLeft { Self.extendPictureEdges(output, placement: placement) }
        return output
    }

    /// Repeats the picture's last column and row into the unused canvas on the right and bottom,
    /// so a client that scales the frame down blends the picture's edge with itself, not with
    /// black. Only for a top-left placement, which leaves no unused area on the left or top.
    static func extendPictureEdges(_ buffer: CVPixelBuffer, placement: LetterboxPlacement) {
        let width = CVPixelBufferGetWidth(buffer)
        let height = CVPixelBufferGetHeight(buffer)
        guard placement.x == 0, placement.y == 0, placement.width > 0, placement.height > 0,
              placement.width < width || placement.height < height else { return }
        CVPixelBufferLockBaseAddress(buffer, [])
        defer { CVPixelBufferUnlockBaseAddress(buffer, []) }
        let planar = CVPixelBufferIsPlanar(buffer)
        for plane in 0..<(planar ? CVPixelBufferGetPlaneCount(buffer) : 1) {
            guard let address = planar ? CVPixelBufferGetBaseAddressOfPlane(buffer, plane)
                                       : CVPixelBufferGetBaseAddress(buffer) else { continue }
            let base = address.assumingMemoryBound(to: UInt8.self)
            let stride = planar ? CVPixelBufferGetBytesPerRowOfPlane(buffer, plane) : CVPixelBufferGetBytesPerRow(buffer)
            let planeWidth = planar ? CVPixelBufferGetWidthOfPlane(buffer, plane) : width
            let planeHeight = planar ? CVPixelBufferGetHeightOfPlane(buffer, plane) : height
            // Luma is 1 byte, interleaved CbCr 2 bytes at half size, BGRA 4 bytes.
            let bytesPerPixel = planar ? (plane == 0 ? 1 : 2) : 4
            let right = placement.width * planeWidth / width
            let bottom = placement.height * planeHeight / height
            guard right > 0, bottom > 0 else { continue }
            for y in 0..<bottom where right < planeWidth {
                let row = base + y * stride
                let edge = row + (right - 1) * bytesPerPixel
                for x in right..<planeWidth { (row + x * bytesPerPixel).update(from: edge, count: bytesPerPixel) }
            }
            let lastRow = base + (bottom - 1) * stride
            for y in bottom..<planeHeight { (base + y * stride).update(from: lastRow, count: planeWidth * bytesPerPixel) }
        }
    }

    private struct PlacedGeometry: Equatable {
        let source: Dimensions
        let canvas: Dimensions
        let placement: LetterboxPlacement
    }
    private var placedGeometry: PlacedGeometry?
    private var placedTransfer: VTPixelTransferSession?
    private var placedTransferUnavailable = false

    deinit {
        if let placedTransfer { VTPixelTransferSessionInvalidate(placedTransfer) }
    }

    func placeForRecording(_ source: CVPixelBuffer, contentSize: Dimensions, width: Int, height: Int)
        -> (buffer: CVPixelBuffer, contentRect: RecordingContentRect)? {
        let size = source.dimensions
        let format = CVPixelBufferGetPixelFormatType(source)
        guard width > 0, height > 0, contentSize.width > 0, contentSize.height > 0,
              contentSize.width <= size.width, contentSize.height <= size.height,
              Self.supports(format) else { return nil }
        if size == Dimensions(width: width, height: height) {
            return (source, RecordingContentRect(x: 0, y: 0,
                width: contentSize.width, height: contentSize.height))
        }
        let placement = LetterboxPlacement(sourceWidth: size.width, sourceHeight: size.height,
            canvasWidth: width, canvasHeight: height)
        let geometry = PlacedGeometry(source: size, canvas: Dimensions(width: width, height: height),
                                      placement: placement)
        guard let transfer = placedSession(geometry),
              let output = makeOutput(width: width, height: height, format: format),
              transferImage(transfer, source, output) == noErr else { return nil }
        transferFrames &+= 1
        // The MP4 retains the full canvas and square pixels; cropping belongs to its timeline.
        for key in [kCVImageBufferCleanApertureKey, kCVImageBufferPreferredCleanApertureKey,
                    kCVImageBufferPixelAspectRatioKey] { CVBufferRemoveAttachment(output, key) }
        // Include partially covered edge pixels when native odd dimensions were padded.
        let contentRect = RecordingContentRect(x: placement.x, y: placement.y,
            width: (contentSize.width * placement.width + size.width - 1) / size.width,
            height: (contentSize.height * placement.height + size.height - 1) / size.height)
        return (output, contentRect)
    }

    /// A transfer session that scales the source into `geometry.placement` of the canvas.
    private func placedSession(_ geometry: PlacedGeometry) -> VTPixelTransferSession? {
        if placedTransferUnavailable { return nil }
        if placedGeometry == geometry { return placedTransfer }
        if placedTransfer == nil {
            guard VTPixelTransferSessionCreate(allocator: kCFAllocatorDefault,
                pixelTransferSessionOut: &placedTransfer) == noErr else {
                placedTransferUnavailable = true
                return nil
            }
        }
        guard let transfer = placedTransfer else { return nil }
        let placement = geometry.placement
        let aperture: [String: Any] = [
            kCVImageBufferCleanApertureWidthKey as String: placement.width,
            kCVImageBufferCleanApertureHeightKey as String: placement.height,
            kCVImageBufferCleanApertureHorizontalOffsetKey as String:
                Double(placement.x) + Double(placement.width - geometry.canvas.width) / 2,
            kCVImageBufferCleanApertureVerticalOffsetKey as String:
                Double(placement.y) + Double(placement.height - geometry.canvas.height) / 2,
        ]
        let aspect: [String: Any] = [
            kCVImageBufferPixelAspectRatioHorizontalSpacingKey as String: geometry.source.width * placement.height,
            kCVImageBufferPixelAspectRatioVerticalSpacingKey as String: geometry.source.height * placement.width,
        ]
        for (key, value) in [
            (kVTPixelTransferPropertyKey_ScalingMode, kVTScalingMode_Letterbox as CFTypeRef),
            (kVTPixelTransferPropertyKey_DestinationCleanAperture, aperture as CFDictionary),
            (kVTPixelTransferPropertyKey_DestinationPixelAspectRatio, aspect as CFDictionary),
        ] {
            guard VTSessionSetProperty(transfer, key: key, value: value) == noErr else {
                VTPixelTransferSessionInvalidate(transfer)
                placedTransfer = nil
                placedTransferUnavailable = true
                return nil
            }
        }
        placedGeometry = geometry
        return transfer
    }

    private func makeOutput(width: Int, height: Int, format: OSType) -> CVPixelBuffer? {
        guard let pool = pixelBufferPool(width: width, height: height, format: format) else { return nil }
        var output: CVPixelBuffer?
        let status: CVReturn
        if let allocationLimit {
            status = CVPixelBufferPoolCreatePixelBufferWithAuxAttributes(kCFAllocatorDefault, pool,
                                                                         allocationLimit, &output)
        } else {
            status = CVPixelBufferPoolCreatePixelBuffer(kCFAllocatorDefault, pool, &output)
        }
        guard status == kCVReturnSuccess, let output else {
            poolDrops &+= 1
            return nil
        }

        return output
    }

    private func transferSession() -> VTPixelTransferSession? {
        if let transfer { return transfer }
        if transferUnavailable { return nil }
        var next: VTPixelTransferSession?
        guard VTPixelTransferSessionCreate(allocator: kCFAllocatorDefault,
                                           pixelTransferSessionOut: &next) == noErr,
              let next else {
            transferUnavailable = true
            print("[stream] VideoToolbox letterbox unavailable; \(allowCPUFallback ? "using CPU scaling" : "dropping frame")")
            return nil
        }
        guard VTSessionSetProperty(next, key: kVTPixelTransferPropertyKey_ScalingMode,
                                   value: kVTScalingMode_Letterbox) == noErr else {
            VTPixelTransferSessionInvalidate(next)
            transferUnavailable = true
            print("[stream] VideoToolbox letterbox mode unavailable; \(allowCPUFallback ? "using CPU scaling" : "dropping frame")")
            return nil
        }
        transfer = next
        return next
    }

    private func placeBiPlanar(
        _ source: CVPixelBuffer, into output: CVPixelBuffer,
        placement: LetterboxPlacement, format: OSType
    ) -> Bool {
        guard CVPixelBufferGetPlaneCount(source) == 2,
              CVPixelBufferGetPlaneCount(output) == 2 else { return false }
        for plane in 0..<2 {
            guard let sourceAddress = CVPixelBufferGetBaseAddressOfPlane(source, plane),
                  let outputAddress = CVPixelBufferGetBaseAddressOfPlane(output, plane) else {
                return false
            }
            let sourceWidth = CVPixelBufferGetWidthOfPlane(source, plane)
            let sourceHeight = CVPixelBufferGetHeightOfPlane(source, plane)
            let outputStride = CVPixelBufferGetBytesPerRowOfPlane(output, plane)
            let outputHeight = CVPixelBufferGetHeightOfPlane(output, plane)
            let fill = plane == 0
                ? (format == kCVPixelFormatType_420YpCbCr8BiPlanarVideoRange ? 16 : 0)
                : 128
            memset(outputAddress, Int32(fill), outputStride * outputHeight)
            let divisor = plane == 0 ? 1 : 2
            var sourceImage = vImage_Buffer(
                data: sourceAddress, height: vImagePixelCount(sourceHeight),
                width: vImagePixelCount(sourceWidth),
                rowBytes: CVPixelBufferGetBytesPerRowOfPlane(source, plane)
            )
            var destination = vImage_Buffer(
                data: outputAddress.advanced(by: placement.y / divisor * outputStride
                    + placement.x),
                height: vImagePixelCount(placement.height / divisor),
                width: vImagePixelCount(placement.width / divisor), rowBytes: outputStride
            )
            let result = plane == 0
                ? vImageScale_Planar8(&sourceImage, &destination, nil, vImage_Flags(kvImageNoFlags))
                : vImageScale_CbCr8(&sourceImage, &destination, nil, vImage_Flags(kvImageNoFlags))
            guard result == kvImageNoError else { return false }
        }
        return true
    }

    private func pixelBufferPool(width: Int, height: Int, format: OSType) -> CVPixelBufferPool? {
        if let pool, poolWidth == width, poolHeight == height, poolFormat == format { return pool }
        let attributes: [String: Any] = [
            kCVPixelBufferPixelFormatTypeKey as String: format,
            kCVPixelBufferWidthKey as String: width,
            kCVPixelBufferHeightKey as String: height,
            kCVPixelBufferIOSurfacePropertiesKey as String: [:],
            kCVPixelBufferMetalCompatibilityKey as String: true,
        ]
        var next: CVPixelBufferPool?
        guard CVPixelBufferPoolCreate(kCFAllocatorDefault, nil, attributes as CFDictionary,
                                      &next) == kCVReturnSuccess else { return nil }
        pool = next
        poolWidth = width
        poolHeight = height
        poolFormat = format
        return next
    }
}
