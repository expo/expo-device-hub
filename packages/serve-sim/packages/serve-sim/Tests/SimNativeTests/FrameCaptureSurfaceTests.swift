import CoreMedia
import CoreVideo
import IOSurface
import XCTest

@testable import SimNative

private final class FakeMonotonicClock: @unchecked Sendable {
    private let lock = NSLock()
    private var nanoseconds: UInt64 = 0

    func now() -> UInt64 { lock.withLock { nanoseconds } }
    func advance(milliseconds: UInt64) { lock.withLock { nanoseconds += milliseconds * 1_000_000 } }
    func setNanoseconds(_ value: UInt64) { lock.withLock { nanoseconds = value } }
}

private final class FakeFramebufferDescriptor: NSObject, FramebufferDescriptor {
    var surface: IOSurface?
    var maskedSurface: IOSurface?
    var registrations = 0
    private(set) var surfaceReads = 0
    private(set) var maskedSurfaceReads = 0
    init(_ surface: IOSurface?) { self.surface = surface }
    @objc func framebufferSurface() -> IOSurface? {
        surfaceReads += 1
        return surface
    }
    @objc func maskedFramebufferSurface() -> IOSurface? {
        maskedSurfaceReads += 1
        return maskedSurface
    }
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
    private var screenChangeCount = 0

    func append(_ pixelBuffer: CVPixelBuffer, canvas: Dimensions?) {
        CVPixelBufferLockBaseAddress(pixelBuffer, .readOnly)
        let luma = CVPixelBufferGetBaseAddressOfPlane(pixelBuffer, 0)!.load(as: UInt8.self)
        CVPixelBufferUnlockBaseAddress(pixelBuffer, .readOnly)
        lock.withLock { frames.append((luma, canvas)) }
    }

    var all: [(luma: UInt8, canvas: Dimensions?)] { lock.withLock { frames } }
    var screenChanges: Int { lock.withLock { screenChangeCount } }
    func recordScreenChange() { lock.withLock { screenChangeCount += 1 } }
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

    private func capture(with descriptor: FakeFramebufferDescriptor, io: NSObject? = nil,
                         clock: FakeMonotonicClock? = nil) async -> (FrameCapture, FrameLog) {
        let capture: FrameCapture
        if let clock {
            capture = FrameCapture(nowNanoseconds: { clock.now() })
        } else {
            capture = FrameCapture()
        }
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

    func testSlowHealthyCaptureDoesNotRewire() async throws {
        let descriptor = FakeFramebufferDescriptor(surface(width: 64, height: 128, gray: 0))
        let io = FakeFramebufferIO()
        io.deviceIOPorts = [FakeFramebufferPort(descriptor)]
        let capture = FrameCapture()
        let log = FrameLog()
        await capture.installDescriptorsForTesting([(descriptor, panel)], io: io) { pixelBuffer, _, canvas in
            log.append(pixelBuffer, canvas: canvas)
            if log.all.count == 2 { Thread.sleep(forTimeInterval: 1.1) }
        }
        await capture.captureFrameForTesting(force: true)
        try await Task.sleep(for: .milliseconds(250))
        await capture.pollSurfaceForTesting()

        let counts = await capture.surfaceLossTimings()
        XCTAssertEqual(log.all.count, 2)
        XCTAssertEqual(counts.losses, 0)
        XCTAssertEqual(counts.rewires, 0)
        XCTAssertEqual(io.updates, 0)
        await capture.stop()
    }

    func testRewireWithResizedSurfaceNotifiesScreenObservers() async throws {
        let descriptor = FakeFramebufferDescriptor(surface(width: 64, height: 128, gray: 0))
        let io = FakeFramebufferIO()
        let capture = FrameCapture()
        let log = FrameLog()
        await capture.installDescriptorsForTesting([(descriptor, nil)], io: io) { pixelBuffer, _, canvas in
            log.append(pixelBuffer, canvas: canvas)
        }
        await capture.captureFrameForTesting(force: true)
        _ = await capture.subscribeScreenChanges { log.recordScreenChange() }
        descriptor.surface = nil
        try await waitForRepick()
        await capture.pollSurfaceForTesting()

        let replacement = FakeFramebufferDescriptor(surface(width: 80, height: 160, gray: 255))
        io.deviceIOPorts = [FakeFramebufferPort(replacement)]
        try await waitForRepick()
        await capture.pollSurfaceForTesting()

        let size = await capture.getScreenSize()
        XCTAssertEqual(log.all.count, 2)
        XCTAssertGreaterThan(log.all.last!.luma, 220)
        XCTAssertEqual(size?.width, 80)
        XCTAssertEqual(size?.height, 160)
        XCTAssertEqual(log.screenChanges, 1)
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

    func testCallbackReplacementPixelsSurviveLaggingOrNilGetters() async throws {
        for getterReturnsNil in [false, true] {
            let dark = surface(width: 64, height: 128, gray: 0)
            let light = surface(width: 64, height: 128, gray: 255)
            XCTAssertEqual(IOSurfaceGetSeed(dark), IOSurfaceGetSeed(light))
            let descriptor = FakeFramebufferDescriptor(dark)
            let clock = FakeMonotonicClock()
            let (capture, log) = await capture(with: descriptor, clock: clock)
            await capture.captureFrameForTesting(force: false)
            let reads = descriptor.surfaceReads
            if getterReturnsNil { descriptor.surface = nil }

            await capture.surfaceChangedForTesting(descriptor: descriptor, masked: light)

            XCTAssertEqual(log.all.count, 2)
            XCTAssertGreaterThan(log.all.last!.luma, 220)
            XCTAssertEqual(descriptor.surfaceReads, reads)
            XCTAssertEqual(descriptor.maskedSurfaceReads, 0)
            await capture.captureFrameForTesting(force: false)
            XCTAssertEqual(log.all.count, 2)
            await capture.stop()
        }
    }

    func testOverdueCallbackReplacementPixelsSurviveLaggingOrNilGetters() async throws {
        for getterReturnsNil in [false, true] {
            let dark = surface(width: 64, height: 128, gray: 0)
            let light = surface(width: 64, height: 128, gray: 255)
            XCTAssertEqual(IOSurfaceGetSeed(dark), IOSurfaceGetSeed(light))
            let descriptor = FakeFramebufferDescriptor(dark)
            let clock = FakeMonotonicClock()
            let (capture, log) = await capture(with: descriptor, clock: clock)
            await capture.captureFrameForTesting(force: false)
            XCTAssertEqual(log.all.count, 1)
            let reads = descriptor.surfaceReads
            clock.advance(milliseconds: 1_100)
            if getterReturnsNil { descriptor.surface = nil }

            await capture.surfaceChangedForTesting(descriptor: descriptor, masked: light)

            XCTAssertEqual(log.all.count, 2)
            XCTAssertGreaterThan(log.all.last?.luma ?? 0, 220)
            XCTAssertEqual(descriptor.surfaceReads, reads)
            XCTAssertEqual(descriptor.maskedSurfaceReads, 0)
            await capture.stop()
        }
    }

    func testCallbackBurstDoesNotReadPrivateGettersBetweenSweeps() async throws {
        let descriptor = FakeFramebufferDescriptor(surface(width: 64, height: 128, gray: 0))
        let clock = FakeMonotonicClock()
        let (capture, log) = await capture(with: descriptor, clock: clock)
        await capture.captureFrameForTesting(force: false)
        let reads = descriptor.surfaceReads

        for _ in 0..<25 {
            await capture.surfaceChangedForTesting(descriptor: descriptor, masked: descriptor.surface)
        }

        XCTAssertEqual(descriptor.surfaceReads, reads)
        XCTAssertEqual(descriptor.maskedSurfaceReads, 0)
        XCTAssertEqual(log.all.count, 1)
        await capture.stop()
    }

    func testCallbackDoesNotPostponeTheNextLiveSweep() async throws {
        let dark = surface(width: 64, height: 128, gray: 0)
        let light = surface(width: 64, height: 128, gray: 255)
        let descriptor = FakeFramebufferDescriptor(dark)
        let clock = FakeMonotonicClock()
        let (capture, log) = await capture(with: descriptor, clock: clock)
        await capture.captureFrameForTesting(force: false)
        let reads = descriptor.surfaceReads

        clock.setNanoseconds(850_000_000)
        await capture.surfaceChangedForTesting(descriptor: descriptor, masked: dark)
        XCTAssertEqual(descriptor.surfaceReads, reads)
        descriptor.surface = light
        clock.advance(milliseconds: 350)
        await capture.captureFrameForTesting(force: false)

        XCTAssertEqual(descriptor.surfaceReads, reads + 1)
        XCTAssertEqual(log.all.count, 2)
        XCTAssertGreaterThan(log.all.last!.luma, 220)
        await capture.stop()
    }

    func testNilSurfaceBurstStaysBoundedAndFindsASilentReturnAtTheNextSweep() async throws {
        let descriptor = FakeFramebufferDescriptor(nil)
        let clock = FakeMonotonicClock()
        let (capture, log) = await capture(with: descriptor, clock: clock)
        await capture.captureFrameForTesting(force: false)
        let reads = descriptor.surfaceReads
        let maskedReads = descriptor.maskedSurfaceReads

        for _ in 0..<25 {
            await capture.surfaceChangedForTesting(descriptor: descriptor, masked: nil)
            await capture.captureFrameForTesting(force: false)
        }
        XCTAssertEqual(descriptor.surfaceReads, reads)
        XCTAssertEqual(descriptor.maskedSurfaceReads, maskedReads)

        descriptor.surface = surface(width: 64, height: 128, gray: 255)
        await capture.captureFrameForTesting(force: false)
        XCTAssertEqual(log.all.count, 0)
        XCTAssertEqual(descriptor.surfaceReads, reads)
        clock.advance(milliseconds: 1_100)
        await capture.captureFrameForTesting(force: false)

        XCTAssertEqual(descriptor.surfaceReads, reads + 1)
        XCTAssertEqual(log.all.count, 1)
        XCTAssertGreaterThan(log.all.last!.luma, 220)
        await capture.stop()
    }

    func testSuccessfulRewireReadsTheReplacementOnceBeforeCapturing() async throws {
        let descriptor = FakeFramebufferDescriptor(surface(width: 64, height: 128, gray: 0))
        let io = FakeFramebufferIO()
        let clock = FakeMonotonicClock()
        let (capture, log) = await capture(with: descriptor, io: io, clock: clock)
        await capture.captureFrameForTesting(force: true)
        descriptor.surface = nil
        let replacement = FakeFramebufferDescriptor(surface(width: 80, height: 160, gray: 255))
        io.deviceIOPorts = [FakeFramebufferPort(replacement)]
        clock.advance(milliseconds: 1_100)
        await capture.pollSurfaceForTesting()

        XCTAssertEqual(io.updates, 1)
        XCTAssertEqual(replacement.registrations, 1)
        XCTAssertEqual(replacement.surfaceReads, 1)
        XCTAssertEqual(log.all.count, 2)
        XCTAssertGreaterThan(log.all.last!.luma, 220)
        await capture.captureFrameForTesting(force: false)
        XCTAssertEqual(replacement.surfaceReads, 1)
        await capture.stop()
    }

    func testCachedNilDoesNotTriggerARewireBeforeTheNextLiveSweep() async throws {
        let descriptor = FakeFramebufferDescriptor(surface(width: 64, height: 128, gray: 0))
        let io = FakeFramebufferIO()
        let clock = FakeMonotonicClock()
        let (capture, log) = await capture(with: descriptor, io: io, clock: clock)
        await capture.captureFrameForTesting(force: true)
        clock.advance(milliseconds: 450)
        await capture.captureFrameForTesting(force: false)
        descriptor.surface = nil
        await capture.surfaceChangedForTesting(descriptor: descriptor, masked: nil)

        clock.advance(milliseconds: 650)
        await capture.pollSurfaceForTesting()
        XCTAssertEqual(io.updates, 0)
        let reads = descriptor.surfaceReads
        descriptor.surface = surface(width: 64, height: 128, gray: 255)

        clock.advance(milliseconds: 450)
        await capture.pollSurfaceForTesting()
        let waiting = await capture.surfaceLossTimings()
        XCTAssertEqual(descriptor.surfaceReads, reads)
        XCTAssertEqual(io.updates, 0)
        XCTAssertEqual(waiting.rewires, 0)
        XCTAssertEqual(log.all.count, 1)

        clock.advance(milliseconds: 700)
        await capture.pollSurfaceForTesting()
        let recovered = await capture.surfaceLossTimings()
        XCTAssertEqual(descriptor.surfaceReads, reads + 1)
        XCTAssertEqual(io.updates, 0)
        XCTAssertEqual(recovered.rewires, 0)
        XCTAssertEqual(log.all.count, 2)
        XCTAssertGreaterThan(log.all.last?.luma ?? 0, 220)
        await capture.stop()
    }

    func testMissingSurfaceFoundByACaptureStillAllowsThePollToRewire() async throws {
        let descriptor = FakeFramebufferDescriptor(surface(width: 64, height: 128, gray: 0))
        let io = FakeFramebufferIO()
        let clock = FakeMonotonicClock()
        let (capture, log) = await capture(with: descriptor, io: io, clock: clock)
        await capture.captureFrameForTesting(force: true)
        descriptor.surface = nil
        clock.advance(milliseconds: 1_100)
        await capture.captureFrameForTesting(force: false)
        XCTAssertEqual(log.all.count, 1)
        XCTAssertEqual(io.updates, 0)

        await capture.pollSurfaceForTesting()
        let counts = await capture.surfaceLossTimings()
        XCTAssertEqual(io.updates, 1)
        XCTAssertEqual(counts.rewires, 1)
        XCTAssertEqual(counts.losses, 1)
        await capture.stop()
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

    func testDescriptorWithoutSurfaceWaitsForTheNextSweepToResumeFrames() async throws {
        let descriptor = FakeFramebufferDescriptor(surface(width: 64, height: 128, gray: 0))
        let clock = FakeMonotonicClock()
        let (capture, log) = await capture(with: descriptor, clock: clock)

        await capture.captureFrameForTesting(force: true)
        descriptor.surface = nil
        clock.advance(milliseconds: 1_100)
        await capture.captureFrameForTesting(force: true)
        XCTAssertEqual(log.all.count, 1, "a dropped surface is not repeated as an idle frame")
        let reads = descriptor.surfaceReads

        descriptor.surface = surface(width: 64, height: 128, gray: 255)
        await capture.captureFrameForTesting(force: true)
        XCTAssertEqual(log.all.count, 1)
        XCTAssertEqual(descriptor.surfaceReads, reads)
        clock.advance(milliseconds: 1_100)
        await capture.captureFrameForTesting(force: true)
        let frames = log.all
        XCTAssertEqual(frames.count, 2)
        guard frames.count == 2 else { return }
        XCTAssertGreaterThan(frames[1].luma, 220)
        await capture.stop()
    }
}
