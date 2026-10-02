import CoreMedia
import CoreVideo
import IOSurface
import XCTest

@testable import SimNative

private final class FakeFramebufferDescriptor: NSObject, FramebufferDescriptor {
    var surface: IOSurface?
    var maskedSurface: IOSurface?
    var registrations = 0
    init(_ surface: IOSurface?) { self.surface = surface }
    @objc func framebufferSurface() -> IOSurface? { surface }
    @objc func maskedFramebufferSurface() -> IOSurface? { maskedSurface }
    func registerScreenCallbacks(
        uuid: UUID, callbackQueue: DispatchQueue,
        frameCallback: @escaping ScreenFrameCallback,
        surfacesChangedCallback: @escaping ScreenSurfacesChangedCallback,
        propertiesChangedCallback: @escaping ScreenPropertiesChangedCallback
    ) { registrations += 1 }
}

private final class FakeFramebufferPort: NSObject {
    @objc let portIdentifier = "com.apple.framebuffer.display"
    @objc let descriptor: NSObject
    init(_ descriptor: NSObject) { self.descriptor = descriptor }
}

private final class FakeFramebufferIO: NSObject {
    @objc dynamic var deviceIOPorts: [NSObject] = []
    var updates = 0
    @objc func updateIOPorts() { updates += 1 }
}

private final class FrameLog: @unchecked Sendable {
    private let lock = NSLock()
    private var frames: [(luma: UInt8, canvas: Dimensions?)] = []

    func append(_ pixelBuffer: CVPixelBuffer, canvas: Dimensions?) {
        CVPixelBufferLockBaseAddress(pixelBuffer, .readOnly)
        let luma = CVPixelBufferGetBaseAddressOfPlane(pixelBuffer, 0)!.load(as: UInt8.self)
        CVPixelBufferUnlockBaseAddress(pixelBuffer, .readOnly)
        lock.withLock { frames.append((luma, canvas)) }
    }

    var all: [(luma: UInt8, canvas: Dimensions?)] { lock.withLock { frames } }
}

final class FrameCaptureSurfaceTests: XCTestCase {
    private let panel = SimDisplayMetadata(screenID: 1, orientation: nil, chromeIdentifier: nil, screenType: 0)

    private func surface(width: Int, height: Int, gray: UInt8) -> IOSurface {
        let surface = IOSurface(properties: [
            .width: width, .height: height, .bytesPerElement: 4,
            .pixelFormat: kCVPixelFormatType_32BGRA,
        ])!
        surface.lock(options: [], seed: nil)
        memset(surface.baseAddress, Int32(gray), surface.allocationSize)
        surface.unlock(options: [], seed: nil)
        return surface
    }

    private func capture(with descriptor: FakeFramebufferDescriptor, io: NSObject? = nil) async -> (FrameCapture, FrameLog) {
        let capture = FrameCapture()
        let log = FrameLog()
        await capture.installDescriptorsForTesting([(descriptor, panel)], io: io) { pixelBuffer, _, canvas in
            log.append(pixelBuffer, canvas: canvas)
        }
        return (capture, log)
    }

    private func waitForRepick() async throws {
        try await Task.sleep(for: .milliseconds(1_100))
    }

    func testMaskedOnlyCallbackSurvivesLiveRepicks() async throws {
        let descriptor = FakeFramebufferDescriptor(nil)
        let light = surface(width: 64, height: 128, gray: 255)
        descriptor.maskedSurface = light
        let (capture, log) = await capture(with: descriptor)

        await capture.surfaceChangedForTesting(descriptor: descriptor, masked: light)
        XCTAssertEqual(log.all.count, 1)
        try await waitForRepick()
        await capture.captureFrameForTesting(force: true)
        XCTAssertEqual(log.all.count, 2)
        XCTAssertTrue(log.all.allSatisfy { $0.luma > 220 })

        descriptor.maskedSurface = nil
        try await waitForRepick()
        await capture.captureFrameForTesting(force: true)
        XCTAssertEqual(log.all.count, 2)
    }

    func testFailedRewireRetriesAndCapturesTheReplacementSurface() async throws {
        let descriptor = FakeFramebufferDescriptor(surface(width: 64, height: 128, gray: 0))
        let io = FakeFramebufferIO()
        let (capture, log) = await capture(with: descriptor, io: io)
        await capture.captureFrameForTesting(force: true)
        descriptor.surface = nil
        try await waitForRepick()
        await capture.pollSurfaceForTesting()
        XCTAssertEqual(io.updates, 1)
        XCTAssertEqual(log.all.count, 1)
        let failed = await capture.surfaceLossTimings()
        XCTAssertEqual(failed.rewires, 1)

        let replacement = FakeFramebufferDescriptor(surface(width: 80, height: 160, gray: 255))
        io.deviceIOPorts = [FakeFramebufferPort(replacement)]
        try await waitForRepick()
        await capture.pollSurfaceForTesting()
        XCTAssertEqual(io.updates, 2)
        XCTAssertEqual(replacement.registrations, 1)
        XCTAssertEqual(log.all.count, 2)
        XCTAssertGreaterThan(log.all.last!.luma, 220)
        let recovered = await capture.surfaceLossTimings()
        XCTAssertEqual(recovered.rewires, 2)
        XCTAssertEqual(recovered.losses, 1)
        await capture.stop()
    }

    func testSurfaceSwappedWithoutCallbackReachesTheStreamAtTheNextRepick() async throws {
        let dark = surface(width: 64, height: 128, gray: 0)
        let light = surface(width: 64, height: 128, gray: 255)
        XCTAssertEqual(IOSurfaceGetSeed(dark), IOSurfaceGetSeed(light), "the swap must not be visible in the seed")
        let descriptor = FakeFramebufferDescriptor(dark)
        let (capture, log) = await capture(with: descriptor)

        await capture.captureFrameForTesting(force: false)
        descriptor.surface = light
        await capture.captureFrameForTesting(force: false)
        XCTAssertEqual(log.all.count, 1, "the cached surface answers until the re-pick")

        try await waitForRepick()
        await capture.captureFrameForTesting(force: false)
        let frames = log.all
        XCTAssertEqual(frames.count, 2, "the re-pick finds the new surface")
        guard frames.count == 2 else { return }
        XCTAssertLessThan(frames[0].luma, 30)
        XCTAssertGreaterThan(frames[1].luma, 220)
    }

    func testResizedSurfaceUpdatesTheCanvas() async throws {
        let descriptor = FakeFramebufferDescriptor(surface(width: 64, height: 128, gray: 0))
        let (capture, log) = await capture(with: descriptor)

        await capture.captureFrameForTesting(force: true)
        descriptor.surface = surface(width: 80, height: 160, gray: 255)
        try await waitForRepick()
        await capture.captureFrameForTesting(force: true)

        XCTAssertEqual(log.all.map(\.canvas), [Dimensions(width: 64, height: 128), Dimensions(width: 80, height: 160)])
    }

    func testDescriptorWithoutSurfaceStopsFramesUntilOneReturns() async throws {
        let descriptor = FakeFramebufferDescriptor(surface(width: 64, height: 128, gray: 0))
        let (capture, log) = await capture(with: descriptor)

        await capture.captureFrameForTesting(force: true)
        descriptor.surface = nil
        try await waitForRepick()
        await capture.captureFrameForTesting(force: true)
        XCTAssertEqual(log.all.count, 1, "a dropped surface is not repeated as an idle frame")

        descriptor.surface = surface(width: 64, height: 128, gray: 255)
        await capture.captureFrameForTesting(force: true)
        let frames = log.all
        XCTAssertEqual(frames.count, 2, "with no surface picked, the next capture re-picks at once")
        guard frames.count == 2 else { return }
        XCTAssertGreaterThan(frames[1].luma, 220)
    }
}
