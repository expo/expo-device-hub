import Accelerate
import CoreVideo
import Foundation
import StreamingPolicy

final class PixelBufferLetterboxer {
    private var pool: CVPixelBufferPool?
    private var poolWidth = 0
    private var poolHeight = 0
    private var poolFormat: OSType = 0

    func place(_ source: CVPixelBuffer, width: Int, height: Int) -> CVPixelBuffer? {
        let format = CVPixelBufferGetPixelFormatType(source)
        guard width > 0, height > 0,
              [kCVPixelFormatType_32BGRA,
               kCVPixelFormatType_420YpCbCr8BiPlanarVideoRange,
               kCVPixelFormatType_420YpCbCr8BiPlanarFullRange].contains(format) else { return nil }
        let sourceWidth = CVPixelBufferGetWidth(source)
        let sourceHeight = CVPixelBufferGetHeight(source)
        if sourceWidth == width, sourceHeight == height { return source }
        let placement = LetterboxPlacement(
            sourceWidth: sourceWidth, sourceHeight: sourceHeight,
            canvasWidth: width, canvasHeight: height
        )
        guard let pool = pixelBufferPool(width: width, height: height, format: format) else { return nil }
        var output: CVPixelBuffer?
        guard CVPixelBufferPoolCreatePixelBuffer(kCFAllocatorDefault, pool, &output) == kCVReturnSuccess,
              let output else { return nil }

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
