import CoreVideo
import CoreGraphics
import Foundation
import ImageIO
import CoreImage

/// Keep CPU readback and PNG compression off the video capture actor.
actor ScreenshotEncoder {
    private let queue = DispatchSerialQueue(label: "screenshot-encoder", qos: .userInitiated)
    nonisolated var unownedExecutor: UnownedSerialExecutor { queue.asUnownedSerialExecutor() }
    private lazy var context = CIContext(options: [.useSoftwareRenderer: false])

    func encode(_ pixels: CVPixelBuffer, orientation: String? = nil, maxWidth: Int = 0) throws -> Data {
        let width = CVPixelBufferGetWidth(pixels), height = CVPixelBufferGetHeight(pixels)
        var image: CGImage
        // Match the preview's display geometry: some runtimes rotate the surface itself,
        // others keep portrait pixels and publish orientation separately.
        let rotation: CGImagePropertyOrientation
        switch orientation {
        case "landscape_left" where width <= height: rotation = .right
        case "landscape_right" where width <= height: rotation = .left
        case "portrait_upside_down": rotation = .down
        default: rotation = .up
        }
        if maxWidth > 0 {
            image = try render(resize(CIImage(cvPixelBuffer: pixels).oriented(rotation), maxWidth: maxWidth))
        } else {
            image = try copyImage(pixels)
            if rotation != .up { image = try render(CIImage(cgImage: image).oriented(rotation)) }
        }
        return try encode(image, jpegQuality: nil)
    }

    /// Also handles the simctl fallback. The artifact stays PNG even for a JPEG response.
    func convert(_ data: Data, maxWidth: Int, jpegQuality: Int?) throws -> Data {
        guard let image = CIImage(data: data) else { throw failure() }
        return try encode(render(resize(image, maxWidth: maxWidth)), jpegQuality: jpegQuality)
    }

    private func resize(_ image: CIImage, maxWidth: Int) -> CIImage {
        guard maxWidth > 0, image.extent.width > CGFloat(maxWidth) else { return image }
        let scale = CGFloat(maxWidth) / image.extent.width
        let height = max(1, (image.extent.height * scale).rounded())
        return image.clampedToExtent().applyingFilter("CILanczosScaleTransform", parameters: [
            kCIInputScaleKey: scale, kCIInputAspectRatioKey: 1,
        ]).cropped(to: CGRect(x: 0, y: 0, width: CGFloat(maxWidth), height: height))
    }

    private func render(_ image: CIImage) throws -> CGImage {
        guard let result = context.createCGImage(image, from: image.extent) else { throw failure() }
        return result
    }

    private func encode(_ image: CGImage, jpegQuality: Int?) throws -> Data {
        let data = NSMutableData()
        guard let destination = CGImageDestinationCreateWithData(data, (jpegQuality != nil ? "public.jpeg" : "public.png") as CFString, 1, nil)
        else { throw failure() }
        CGImageDestinationAddImage(destination, image, jpegQuality.map {
            [kCGImageDestinationLossyCompressionQuality: Double($0) / 100] as CFDictionary
        })
        guard CGImageDestinationFinalize(destination) else { throw failure() }
        return data as Data
    }

    private func copyImage(_ pixels: CVPixelBuffer) throws -> CGImage {
        guard CVPixelBufferLockBaseAddress(pixels, .readOnly) == kCVReturnSuccess else { throw failure() }
        defer { CVPixelBufferUnlockBaseAddress(pixels, .readOnly) }
        let width = CVPixelBufferGetWidth(pixels), height = CVPixelBufferGetHeight(pixels)
        guard let source = CVPixelBufferGetBaseAddress(pixels),
              let context = CGContext(data: nil, width: width, height: height,
                  bitsPerComponent: 8, bytesPerRow: 0, space: CGColorSpaceCreateDeviceRGB(),
                  bitmapInfo: CGBitmapInfo.byteOrder32Little.rawValue | CGImageAlphaInfo.premultipliedFirst.rawValue),
              let destination = context.data else { throw failure() }
        for row in 0..<height {
            memcpy(destination.advanced(by: row * context.bytesPerRow),
                   source.advanced(by: row * CVPixelBufferGetBytesPerRow(pixels)), width * 4)
        }
        guard let image = context.makeImage() else { throw failure() }
        return image
    }

    private func failure() -> NSError {
        NSError(domain: "serve-sim-screenshot", code: 1,
                userInfo: [NSLocalizedDescriptionKey: "Could not encode screenshot"])
    }
}
