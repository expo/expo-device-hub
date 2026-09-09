import Accelerate
import CoreVideo
import Foundation

/// Mutable scratch state confined to the owning MJPEGEncoder or AVCCEncoder actor.
final class PixelBufferScaler: @unchecked Sendable {
    private var pool: CVPixelBufferPool?
    private var poolWidth = 0
    private var poolHeight = 0

    func scale(_ source: CVPixelBuffer, maxDimension: Int) -> CVPixelBuffer? {
        let width = CVPixelBufferGetWidth(source)
        let height = CVPixelBufferGetHeight(source)
        guard maxDimension > 0, max(width, height) > maxDimension else { return source }

        let scale = Double(maxDimension) / Double(max(width, height))
        let targetWidth = evenDimension(width, scale: scale)
        let targetHeight = evenDimension(height, scale: scale)
        var output: CVPixelBuffer?
        guard let pool = pixelBufferPool(width: targetWidth, height: targetHeight),
              CVPixelBufferPoolCreatePixelBuffer(kCFAllocatorDefault, pool, &output) == kCVReturnSuccess,
              let output else {
            return nil
        }

        CVPixelBufferLockBaseAddress(source, .readOnly)
        CVPixelBufferLockBaseAddress(output, [])
        defer {
            CVPixelBufferUnlockBaseAddress(output, [])
            CVPixelBufferUnlockBaseAddress(source, .readOnly)
        }
        guard CVPixelBufferGetPixelFormatType(source) == kCVPixelFormatType_32BGRA,
              let sourceAddress = CVPixelBufferGetBaseAddress(source),
              let outputAddress = CVPixelBufferGetBaseAddress(output) else {
            return nil
        }
        var sourceBuffer = vImage_Buffer(
            data: sourceAddress,
            height: vImagePixelCount(height),
            width: vImagePixelCount(width),
            rowBytes: CVPixelBufferGetBytesPerRow(source)
        )
        var outputBuffer = vImage_Buffer(
            data: outputAddress,
            height: vImagePixelCount(targetHeight),
            width: vImagePixelCount(targetWidth),
            rowBytes: CVPixelBufferGetBytesPerRow(output)
        )
        return vImageScale_ARGB8888(
            &sourceBuffer,
            &outputBuffer,
            nil,
            vImage_Flags(kvImageNoFlags)
        ) == kvImageNoError ? output : nil
    }

    private func pixelBufferPool(width: Int, height: Int) -> CVPixelBufferPool? {
        if let pool, poolWidth == width, poolHeight == height { return pool }
        let attributes: [String: Any] = [
            kCVPixelBufferPixelFormatTypeKey as String: kCVPixelFormatType_32BGRA,
            kCVPixelBufferWidthKey as String: width,
            kCVPixelBufferHeightKey as String: height,
            kCVPixelBufferIOSurfacePropertiesKey as String: [:],
        ]
        var nextPool: CVPixelBufferPool?
        guard CVPixelBufferPoolCreate(
            kCFAllocatorDefault,
            nil,
            attributes as CFDictionary,
            &nextPool
        ) == kCVReturnSuccess else {
            return nil
        }
        pool = nextPool
        poolWidth = width
        poolHeight = height
        return nextPool
    }

    private func evenDimension(_ value: Int, scale: Double) -> Int {
        let scaled = max(2, Int((Double(value) * scale).rounded()))
        return scaled.isMultiple(of: 2) ? scaled : scaled - 1
    }
}
