import CoreGraphics
import CoreVideo
import ImageIO
import XCTest
@testable import SimNative

final class ScreenshotEncoderTests: XCTestCase {
    func testCompressionStressPatterns() async throws {
        let encoder = ScreenshotEncoder()
        var sizes: [String: Int] = [:]
        for pattern in ["solid", "gradient", "texture", "noise"] {
            let input = try pixels(width: 1206, height: 2622, red: 255)
            CVPixelBufferLockBaseAddress(input, [])
            let base = try XCTUnwrap(CVPixelBufferGetBaseAddress(input))
            var random: UInt32 = 42
            for y in 0..<2622 {
                let row = base.advanced(by: y * CVPixelBufferGetBytesPerRow(input)).assumingMemoryBound(to: UInt8.self)
                for x in 0..<1206 {
                    for channel in 0..<3 {
                        random = random &* 1664525 &+ 1013904223
                        let gradient = (x * 100 / 1206 + y * 100 / 2622 + channel * 20) % 224
                        switch pattern {
                        case "gradient": row[x * 4 + channel] = UInt8(gradient)
                        case "texture": row[x * 4 + channel] = UInt8(gradient + Int(random >> 27))
                        case "noise": row[x * 4 + channel] = UInt8(truncatingIfNeeded: random >> 16)
                        default: break
                        }
                    }
                }
            }
            CVPixelBufferUnlockBaseAddress(input, [])
            for sample in 0..<5 {
                let fullStarted = DispatchTime.now().uptimeNanoseconds
                let full = try await encoder.encode(input)
                let smallStarted = DispatchTime.now().uptimeNanoseconds
                let small = try await encoder.encode(input, maxWidth: 402)
                let jpegStarted = DispatchTime.now().uptimeNanoseconds
                let jpeg = try await encoder.convert(small, maxWidth: 0, jpegQuality: 80)
                let finished = DispatchTime.now().uptimeNanoseconds
                sizes[pattern] = full.count
                XCTAssertLessThan(small.count, full.count)
                print("SCREENSHOT_SIZE pattern=\(pattern) sample=\(sample) nativePng=\(full.count) resizedPng=\(small.count) resizedJpeg=\(jpeg.count) nativeNs=\(smallStarted - fullStarted) resizedNs=\(jpegStarted - smallStarted) jpegNs=\(finished - jpegStarted)")
            }
        }
        XCTAssertGreaterThan(sizes["noise"]!, sizes["solid"]! * 10)
    }

    func testJpegConversionAndEncodedFallbackResize() async throws {
        let encoder = ScreenshotEncoder()
        let input = try pixels(width: 1206, height: 2622, red: 255)
        let png = try await encoder.encode(input)
        for quality in [nil, 40, 80, 100] as [Int?] {
            let data = try await encoder.convert(png, maxWidth: 402, jpegQuality: quality)
            let source = try XCTUnwrap(CGImageSourceCreateWithData(data as CFData, nil))
            XCTAssertEqual(CGImageSourceGetType(source) as String?, quality == nil ? "public.png" : "public.jpeg")
            let image = try XCTUnwrap(CGImageSourceCreateImageAtIndex(source, 0, nil))
            XCTAssertEqual(image.width, 402)
            XCTAssertEqual(image.height, 874)
        }
    }

    func testResizePreservesAspectRatioAfterOrientationAndNeverUpscales() async throws {
        let encoder = ScreenshotEncoder()
        for (width, height, orientation, limit, expectedWidth, expectedHeight) in [
            (1206, 2622, "portrait", 402, 402, 874),
            (1206, 2622, "landscape_left", 402, 402, 185),
            (17, 31, "portrait", 402, 17, 31),
            (17, 31, "portrait", 1, 1, 2),
        ] {
            let input = try pixels(width: width, height: height, red: 255)
            let data = try await encoder.encode(input, orientation: orientation, maxWidth: limit)
            let source = try XCTUnwrap(CGImageSourceCreateWithData(data as CFData, nil))
            let image = try XCTUnwrap(CGImageSourceCreateImageAtIndex(source, 0, nil))
            XCTAssertEqual(image.width, expectedWidth)
            XCTAssertEqual(image.height, expectedHeight)
        }
    }

    private func pixels(width: Int, height: Int, red: UInt8) throws -> CVPixelBuffer {
        var buffer: CVPixelBuffer?
        XCTAssertEqual(CVPixelBufferCreate(kCFAllocatorDefault, width, height,
            kCVPixelFormatType_32BGRA, nil, &buffer), kCVReturnSuccess)
        let result = try XCTUnwrap(buffer)
        CVPixelBufferLockBaseAddress(result, [])
        defer { CVPixelBufferUnlockBaseAddress(result, []) }
        let base = try XCTUnwrap(CVPixelBufferGetBaseAddress(result))
        for y in 0..<height {
            let row = base.advanced(by: y * CVPixelBufferGetBytesPerRow(result)).assumingMemoryBound(to: UInt8.self)
            for x in 0..<width {
                row[x * 4] = 0; row[x * 4 + 1] = 0
                row[x * 4 + 2] = red; row[x * 4 + 3] = 255
            }
        }
        return result
    }

    func testNativeDimensionsIncludingPortraitLandscapeAndOddSizes() async throws {
        let encoder = ScreenshotEncoder()
        for (width, height) in [(1206, 2622), (2622, 1206), (17, 31), (31, 17), (1, 1)] {
            let input = try pixels(width: width, height: height, red: 255)
            let data = try await encoder.encode(input)
            XCTAssertEqual(Array(data.prefix(8)), [137, 80, 78, 71, 13, 10, 26, 10])
            let source = try XCTUnwrap(CGImageSourceCreateWithData(data as CFData, nil))
            let image = try XCTUnwrap(CGImageSourceCreateImageAtIndex(source, 0, nil))
            XCTAssertEqual(image.width, width)
            XCTAssertEqual(image.height, height)
        }
    }

    func testRepeatedAndConcurrentExportsKeepEachFramesPixels() async throws {
        let encoder = ScreenshotEncoder()
        try await withThrowingTaskGroup(of: Void.self) { group in
            for value in 0..<32 {
                let input = try pixels(width: 17, height: 31, red: UInt8(value * 8))
                group.addTask {
                    let png = try await encoder.encode(input)
                    let source = try XCTUnwrap(CGImageSourceCreateWithData(png as CFData, nil))
                    let image = try XCTUnwrap(CGImageSourceCreateImageAtIndex(source, 0, nil))
                    var rgba = [UInt8](repeating: 0, count: 4)
                    try rgba.withUnsafeMutableBytes { bytes in
                        let context = try XCTUnwrap(CGContext(data: bytes.baseAddress, width: 1, height: 1,
                            bitsPerComponent: 8, bytesPerRow: 4, space: CGColorSpaceCreateDeviceRGB(),
                            bitmapInfo: CGImageAlphaInfo.premultipliedLast.rawValue))
                        context.draw(image, in: CGRect(x: 0, y: 0, width: 1, height: 1))
                    }
                    XCTAssertEqual(Int(rgba[0]), value * 8, accuracy: 1)
                    XCTAssertEqual(rgba[1], 0); XCTAssertEqual(rgba[2], 0); XCTAssertEqual(rgba[3], 255)
                }
            }
            try await group.waitForAll()
        }
    }

    func testDisplayOrientationAndAlreadyRotatedSurfaces() async throws {
        let encoder = ScreenshotEncoder()
        for (width, height, orientation, expectedWidth, expectedHeight) in [
            (17, 31, "landscape_left", 31, 17),
            (17, 31, "landscape_right", 31, 17),
            (17, 31, "portrait_upside_down", 17, 31),
            (31, 17, "landscape_left", 31, 17),
            (31, 17, "landscape_right", 31, 17),
        ] {
            let input = try pixels(width: width, height: height, red: 255)
            let png = try await encoder.encode(input, orientation: orientation)
            let source = try XCTUnwrap(CGImageSourceCreateWithData(png as CFData, nil))
            let image = try XCTUnwrap(CGImageSourceCreateImageAtIndex(source, 0, nil))
            XCTAssertEqual(image.width, expectedWidth)
            XCTAssertEqual(image.height, expectedHeight)
        }
    }

    func testCaptureBeforeStartAndAfterStopFailsInsteadOfReturningOldPixels() async throws {
        let capture = FrameCapture()
        for _ in 0..<2 {
            do {
                _ = try await capture.screenshotPixels(screenID: 1)
                XCTFail("Unavailable capture returned pixels")
            } catch { }
            await capture.stop()
        }
    }

    func testOrientationPreservesAsymmetricPixelPositions() async throws {
        let input = try pixels(width: 2, height: 3, red: 0)
        CVPixelBufferLockBaseAddress(input, [])
        let base = try XCTUnwrap(CVPixelBufferGetBaseAddress(input))
        for y in 0..<3 {
            let row = base.advanced(by: y * CVPixelBufferGetBytesPerRow(input)).assumingMemoryBound(to: UInt8.self)
            for x in 0..<2 { row[x * 4 + 2] = UInt8((y * 2 + x + 1) * 30) }
        }
        CVPixelBufferUnlockBaseAddress(input, [])
        let encoder = ScreenshotEncoder()
        for (orientation, expected) in [
            ("portrait", [30, 60, 90, 120, 150, 180]),
            ("landscape_left", [150, 90, 30, 180, 120, 60]),
            ("landscape_right", [60, 120, 180, 30, 90, 150]),
            ("portrait_upside_down", [180, 150, 120, 90, 60, 30]),
        ] {
            let png = try await encoder.encode(input, orientation: orientation)
            let source = try XCTUnwrap(CGImageSourceCreateWithData(png as CFData, nil))
            let image = try XCTUnwrap(CGImageSourceCreateImageAtIndex(source, 0, nil))
            var rgba = [UInt8](repeating: 0, count: image.width * image.height * 4)
            try rgba.withUnsafeMutableBytes { bytes in
                let context = try XCTUnwrap(CGContext(data: bytes.baseAddress, width: image.width,
                    height: image.height, bitsPerComponent: 8, bytesPerRow: image.width * 4,
                    space: CGColorSpaceCreateDeviceRGB(), bitmapInfo: CGImageAlphaInfo.premultipliedLast.rawValue))
                context.draw(image, in: CGRect(x: 0, y: 0, width: image.width, height: image.height))
            }
            XCTAssertEqual(stride(from: 0, to: rgba.count, by: 4).map { Int(rgba[$0]) }, expected, orientation)
        }
    }
}
