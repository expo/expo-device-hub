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

    /// `preferCPU` skips the VideoToolbox transfer and scales with vImage from the start.
    init(allowCPUFallback: Bool = true, maxBuffers: Int? = nil, preferCPU: Bool = false) {
        self.allowCPUFallback = allowCPUFallback
        allocationLimit = maxBuffers.map { [kCVPixelBufferPoolAllocationThresholdKey as String: $0] as CFDictionary }
        transferUnavailable = preferCPU && allowCPUFallback
    }

    static func supports(_ format: OSType) -> Bool {
        [kCVPixelFormatType_32BGRA,
         kCVPixelFormatType_420YpCbCr8BiPlanarVideoRange,
         kCVPixelFormatType_420YpCbCr8BiPlanarFullRange].contains(format)
    }

    func place(_ source: CVPixelBuffer, width: Int, height: Int) -> CVPixelBuffer? {
        let format = CVPixelBufferGetPixelFormatType(source)
        guard width > 0, height > 0, Self.supports(format) else { return nil }
        let sourceWidth = CVPixelBufferGetWidth(source)
        let sourceHeight = CVPixelBufferGetHeight(source)
        if sourceWidth == width, sourceHeight == height { return source }
        let placement = LetterboxPlacement(
            sourceWidth: sourceWidth, sourceHeight: sourceHeight,
            canvasWidth: width, canvasHeight: height
        )
        guard let output = makeOutput(width: width, height: height, format: format) else { return nil }

        if let transfer = transferSession(),
           VTPixelTransferSessionTransferImage(transfer, from: source, to: output) == noErr {
            transferFrames &+= 1
            return output
        }
        if let transfer {
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
            return placeBiPlanar(source, into: output, placement: placement, format: format)
                ? output : nil
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
        return output
    }

    private struct RecordingGeometry: Equatable {
        let source: Dimensions
        let canvas: Dimensions
    }
    private var recordingGeometry: RecordingGeometry?
    private var recordingTransfer: VTPixelTransferSession?
    private var recordingTransferUnavailable = false

    deinit {
        if let recordingTransfer { VTPixelTransferSessionInvalidate(recordingTransfer) }
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
        let geometry = RecordingGeometry(source: size, canvas: Dimensions(width: width, height: height))
        guard let transfer = recordingSession(geometry, placement: placement),
              let output = makeOutput(width: width, height: height, format: format),
              VTPixelTransferSessionTransferImage(transfer, from: source, to: output) == noErr else { return nil }
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

    private func recordingSession(_ geometry: RecordingGeometry, placement: LetterboxPlacement)
        -> VTPixelTransferSession? {
        if recordingTransferUnavailable { return nil }
        if recordingGeometry == geometry { return recordingTransfer }
        if recordingTransfer == nil {
            guard VTPixelTransferSessionCreate(allocator: kCFAllocatorDefault,
                pixelTransferSessionOut: &recordingTransfer) == noErr else {
                recordingTransferUnavailable = true
                return nil
            }
        }
        guard let transfer = recordingTransfer else { return nil }
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
                recordingTransfer = nil
                recordingTransferUnavailable = true
                return nil
            }
        }
        recordingGeometry = geometry
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
