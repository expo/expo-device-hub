import CoreImage
import CoreVideo
import Foundation
import CoreGraphics
import ImageIO
import UniformTypeIdentifiers

/// Encodes CVPixelBuffer frames as JPEG data for MJPEG streaming.
actor VideoEncoder {
    // makes sure we don't block the main thread / cooperative thread pool
    let queue = DispatchSerialQueue(label: "video-encoder", qos: .userInteractive)

    nonisolated var unownedExecutor: UnownedSerialExecutor { queue.asUnownedSerialExecutor() }

    private let quality: CGFloat

    init(quality: CGFloat = 0.7) {
        self.quality = quality
    }

    private lazy var ciContext = CIContext(options: [.useSoftwareRenderer: false])

    func encode(pixelBuffer: CVPixelBuffer) throws -> Data {
        if CVPixelBufferGetPixelFormatType(pixelBuffer) != kCVPixelFormatType_32BGRA {
            return try encodeViaCoreImage(pixelBuffer)
        }
        CVPixelBufferLockBaseAddress(pixelBuffer, .readOnly)
        defer { CVPixelBufferUnlockBaseAddress(pixelBuffer, .readOnly) }

        let width = CVPixelBufferGetWidth(pixelBuffer)
        let height = CVPixelBufferGetHeight(pixelBuffer)
        guard let baseAddress = CVPixelBufferGetBaseAddress(pixelBuffer) else {
            throw Errors.invalidPixelBuffer
        }
        let bytesPerRow = CVPixelBufferGetBytesPerRow(pixelBuffer)

        let colorSpace = CGColorSpaceCreateDeviceRGB()
        guard let context = CGContext(
            data: baseAddress,
            width: width,
            height: height,
            bitsPerComponent: 8,
            bytesPerRow: bytesPerRow,
            space: colorSpace,
            bitmapInfo: CGBitmapInfo.byteOrder32Little.rawValue | CGImageAlphaInfo.premultipliedFirst.rawValue
        ), let cgImage = context.makeImage() else {
            throw Errors.encodingFailed
        }

        return try jpeg(from: cgImage)
    }

    private func encodeViaCoreImage(_ pixelBuffer: CVPixelBuffer) throws -> Data {
        let image = CIImage(cvPixelBuffer: pixelBuffer)
        guard let cgImage = ciContext.createCGImage(image, from: image.extent) else {
            throw Errors.encodingFailed
        }
        return try jpeg(from: cgImage)
    }

    private func jpeg(from cgImage: CGImage) throws -> Data {
        let data = NSMutableData()
        guard let dest = CGImageDestinationCreateWithData(
            data as CFMutableData, "public.jpeg" as CFString, 1, nil
        ) else {
            throw Errors.encodingFailed
        }
        CGImageDestinationAddImage(
            dest, cgImage, [kCGImageDestinationLossyCompressionQuality: quality] as CFDictionary
        )
        guard CGImageDestinationFinalize(dest) else {
            throw Errors.encodingFailed
        }
        return data as Data
    }

    enum Errors: Error {
        case invalidPixelBuffer
        case encodingFailed
    }
}
