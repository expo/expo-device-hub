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

    func encode(_ pixels: CVPixelBuffer, orientation: String? = nil) throws -> Data {
        var image = try copyImage(pixels)
        // Match the preview's display geometry: some runtimes rotate the surface itself,
        // others keep portrait pixels and publish orientation separately.
        let rotation: CGImagePropertyOrientation
        switch orientation {
        case "landscape_left" where image.width <= image.height: rotation = .right
        case "landscape_right" where image.width <= image.height: rotation = .left
        case "portrait_upside_down": rotation = .down
        default: rotation = .up
        }
        if rotation != .up {
            let rotated = CIImage(cgImage: image).oriented(rotation)
            guard let result = self.context.createCGImage(rotated, from: rotated.extent) else { throw failure() }
            image = result
        }
        let data = NSMutableData()
        guard let destination = CGImageDestinationCreateWithData(data, "public.png" as CFString, 1, nil)
        else { throw failure() }
        CGImageDestinationAddImage(destination, image, nil)
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
