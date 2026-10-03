import CoreVideo
import XCTest
@testable import SimNative

/// A backend the test completes by hand, so replacement and ordering are deterministic.
private final class ManualBackend: ViewerResizeBackend {
    let name: String
    var poolDrops: UInt64 = 0
    private let lock = NSLock()
    private let requested = DispatchSemaphore(value: 0)
    private var waiting: [(source: CVPixelBuffer, completion: (CVPixelBuffer?) -> Void)] = []
    private var recordedRequests: [CVPixelBuffer] = []
    var result: (CVPixelBuffer) -> CVPixelBuffer? = { $0 }
    var supported: (CVPixelBuffer) -> Bool = { _ in true }

    init(name: String = "manual") { self.name = name }

    func supports(_ source: CVPixelBuffer) -> Bool { supported(source) }

    func resize(_ source: CVPixelBuffer, to target: Dimensions,
                completion: @escaping (CVPixelBuffer?) -> Void) {
        lock.lock()
        recordedRequests.append(source)
        waiting.append((source, completion))
        lock.unlock()
        requested.signal()
    }

    var requests: [CVPixelBuffer] {
        lock.lock(); defer { lock.unlock() }; return recordedRequests
    }

    func waitForRequest() {
        XCTAssertEqual(requested.wait(timeout: .now() + 3), .success)
    }

    func completeNext() {
        lock.lock()
        let next = waiting.removeFirst()
        lock.unlock()
        next.completion(result(next.source))
    }
}

private final class ImmediateBackend: ViewerResizeBackend {
    let name = "immediate"
    var poolDrops: UInt64 = 0
    var supported: (CVPixelBuffer) -> Bool = { _ in true }
    func supports(_ source: CVPixelBuffer) -> Bool { supported(source) }
    func resize(_ source: CVPixelBuffer, to target: Dimensions,
                completion: @escaping (CVPixelBuffer?) -> Void) {
        completion(source)
    }
}

private final class Delivered: @unchecked Sendable {
    private let lock = NSLock()
    private let received = DispatchSemaphore(value: 0)
    private var items: [(CVPixelBuffer, UInt64, UInt64)] = []

    func append(_ buffer: CVPixelBuffer, _ sequence: UInt64, _ generation: UInt64 = 0) {
        lock.lock(); items.append((buffer, sequence, generation)); lock.unlock()
        received.signal()
    }

    func waitForFrame() {
        XCTAssertEqual(received.wait(timeout: .now() + 3), .success)
    }

    var sequences: [UInt64] { lock.lock(); defer { lock.unlock() }; return items.map(\.1) }
    var buffers: [CVPixelBuffer] { lock.lock(); defer { lock.unlock() }; return items.map(\.0) }
    var generations: [UInt64] { lock.lock(); defer { lock.unlock() }; return items.map(\.2) }
}

private final class FrameLifetime {
    weak var token: NSObject?
    init(_ token: NSObject) { self.token = token }
}

final class ViewerFrameResizerTests: XCTestCase {
    func testBlockedPassThroughRetainsAndDeliversOnlyNewestWaitingFrame() {
        let backend = ManualBackend()
        let delivered = Delivered()
        let entered = DispatchSemaphore(value: 0)
        let release = DispatchSemaphore(value: 0)
        let newestDelivered = expectation(description: "newest frame delivered")
        let resizer = ViewerFrameResizer(backend: backend, fallback: nil) { buffer, sequence, _ in
            if sequence == 1 {
                entered.signal()
                XCTAssertEqual(release.wait(timeout: .now() + 5), .success)
            }
            delivered.append(buffer, sequence)
            if sequence == 100 { newestDelivered.fulfill() }
        }
        defer { release.signal() }
        resizer.submit(makeBuffer(width: 4, height: 4, format: kCVPixelFormatType_32BGRA))
        guard entered.wait(timeout: .now() + 3) == .success else {
            XCTFail("first frame did not reach output")
            return
        }

        var lifetimes: [FrameLifetime] = []
        for _ in 2...100 {
            autoreleasepool {
                let frame = makeBuffer(width: 4, height: 4, format: kCVPixelFormatType_32BGRA)
                let token = NSObject()
                CVBufferSetAttachment(frame, "test.lifetime" as CFString, token, .shouldNotPropagate)
                lifetimes.append(FrameLifetime(token))
                resizer.submit(frame)
            }
        }
        XCTAssertEqual(lifetimes.filter { $0.token != nil }.count, 1,
                       "blocked output must retain one waiting frame, not 99 queued frames")
        XCTAssertNotNil(lifetimes.last?.token)
        release.signal()
        wait(for: [newestDelivered], timeout: 3)

        XCTAssertEqual(delivered.sequences, [1, 100])
        XCTAssertTrue(backend.requests.isEmpty)
        let counters = resizer.currentCounters()
        XCTAssertEqual(counters.submitted, 100)
        XCTAssertEqual(counters.passedThrough, 2)
        XCTAssertEqual(counters.replaced, 98)
    }

    func testPassesThroughWhenSizeMatchesOrNoTarget() {
        let backend = ManualBackend()
        let delivered = Delivered()
        let resizer = ViewerFrameResizer(backend: backend, fallback: nil) { buffer, sequence, _ in
            delivered.append(buffer, sequence)
        }
        let frame = makeBuffer(width: 64, height: 128, format: kCVPixelFormatType_420YpCbCr8BiPlanarVideoRange)

        resizer.submit(frame)
        delivered.waitForFrame()
        resizer.setTarget(Dimensions(width: 64, height: 128))
        resizer.submit(frame)
        delivered.waitForFrame()

        XCTAssertEqual(delivered.sequences, [1, 2])
        XCTAssertTrue(delivered.buffers.allSatisfy { $0 === frame })
        XCTAssertTrue(backend.requests.isEmpty)
        let counters = resizer.currentCounters()
        XCTAssertEqual(counters.submitted, 2)
        XCTAssertEqual(counters.passedThrough, 2)
    }

    func testLatestFrameReplacesTheWaitingFrameWhileOneIsInFlight() {
        let backend = ManualBackend()
        let delivered = Delivered()
        let resizer = ViewerFrameResizer(backend: backend, fallback: nil) { buffer, sequence, _ in
            delivered.append(buffer, sequence)
        }
        resizer.setTarget(Dimensions(width: 32, height: 64))
        let frames = (0..<3).map { _ in
            makeBuffer(width: 64, height: 128, format: kCVPixelFormatType_420YpCbCr8BiPlanarVideoRange)
        }

        resizer.submit(frames[0])
        backend.waitForRequest()
        resizer.submit(frames[1])
        resizer.submit(frames[2])
        XCTAssertEqual(backend.requests.count, 1, "the second and third frames wait behind the first")

        backend.completeNext()
        delivered.waitForFrame()
        backend.waitForRequest()
        XCTAssertEqual(delivered.sequences, [1])
        XCTAssertEqual(backend.requests.count, 2)
        XCTAssertTrue(backend.requests[1] === frames[2], "the newest waiting frame is resized, the older one is dropped")

        backend.completeNext()
        delivered.waitForFrame()
        XCTAssertEqual(delivered.sequences, [1, 3])
        let counters = resizer.currentCounters()
        XCTAssertEqual(counters.scaled, 2)
        XCTAssertEqual(counters.replaced, 1)
        XCTAssertEqual(counters.submitted, 3)
    }

    func testInFlightCompletionKeepsItsGenerationAndNewestFrameUsesUpdatedTarget() {
        let backend = ManualBackend()
        let delivered = Delivered()
        let resizer = ViewerFrameResizer(backend: backend, fallback: nil) { buffer, sequence, generation in
            delivered.append(buffer, sequence, generation)
        }
        resizer.setTarget(Dimensions(width: 32, height: 64))
        let frame = makeBuffer(width: 64, height: 128,
                               format: kCVPixelFormatType_420YpCbCr8BiPlanarVideoRange)
        resizer.submit(frame, acceptanceGeneration: 1)
        backend.waitForRequest()
        resizer.submit(frame, acceptanceGeneration: 2)
        resizer.submit(frame, acceptanceGeneration: 3)
        resizer.setTarget(nil)

        backend.completeNext()
        delivered.waitForFrame()
        delivered.waitForFrame()
        XCTAssertEqual(delivered.sequences, [1, 3])
        XCTAssertEqual(delivered.generations, [1, 3])
        XCTAssertEqual(backend.requests.count, 1)
        let counters = resizer.currentCounters()
        XCTAssertEqual(counters.scaled, 1)
        XCTAssertEqual(counters.passedThrough, 1)
        XCTAssertEqual(counters.replaced, 1)
    }

    func testSynchronousResizeCanSubmitNewestFrameDuringOutputAndRestart() {
        let backend = ImmediateBackend()
        let delivered = Delivered()
        weak var target: ViewerFrameResizer?
        let resizer = ViewerFrameResizer(backend: backend, fallback: nil) { buffer, sequence, generation in
            delivered.append(buffer, sequence, generation)
            if sequence == 1 {
                target?.submit(buffer, acceptanceGeneration: 2)
                target?.submit(buffer, acceptanceGeneration: 3)
            }
        }
        target = resizer
        resizer.setTarget(Dimensions(width: 2, height: 2))
        let frame = makeBuffer(width: 4, height: 4, format: kCVPixelFormatType_32BGRA)

        resizer.submit(frame, acceptanceGeneration: 1)
        delivered.waitForFrame()
        delivered.waitForFrame()
        XCTAssertEqual(delivered.sequences, [1, 3])
        XCTAssertEqual(delivered.generations, [1, 3])

        for generation in UInt64(4)...20 {
            // The first barrier may precede output's queued continuation;
            // the second waits for that empty drain before the next admission.
            _ = resizer.currentCounters()
            _ = resizer.currentCounters()
            resizer.submit(frame, acceptanceGeneration: generation)
            delivered.waitForFrame()
        }
        XCTAssertEqual(delivered.sequences, [1] + Array(UInt64(3)...20))
        let counters = resizer.currentCounters()
        XCTAssertEqual(counters.submitted, 20)
        XCTAssertEqual(counters.scaled, 19)
        XCTAssertEqual(counters.replaced, 1)
    }

    func testUnsupportedFrameAdvancesToWaitingSupportedFrame() {
        let backend = ImmediateBackend()
        let entered = DispatchSemaphore(value: 0)
        let release = DispatchSemaphore(value: 0)
        let delivered = Delivered()
        backend.supported = { frame in
            if CVPixelBufferGetPixelFormatType(frame) == kCVPixelFormatType_32BGRA {
                entered.signal()
                XCTAssertEqual(release.wait(timeout: .now() + 5), .success)
                return false
            }
            return true
        }
        let resizer = ViewerFrameResizer(backend: backend, fallback: nil) { buffer, sequence, _ in
            delivered.append(buffer, sequence)
        }
        defer { release.signal() }
        resizer.setTarget(Dimensions(width: 2, height: 2))
        resizer.submit(makeBuffer(width: 4, height: 4, format: kCVPixelFormatType_32BGRA))
        guard entered.wait(timeout: .now() + 3) == .success else {
            XCTFail("first frame did not reach backend selection")
            return
        }
        resizer.submit(makeBuffer(width: 4, height: 4, format: kCVPixelFormatType_420YpCbCr8BiPlanarVideoRange))
        release.signal()
        delivered.waitForFrame()

        XCTAssertEqual(delivered.sequences, [2])
        let counters = resizer.currentCounters()
        XCTAssertEqual(counters.failures, 1)
        XCTAssertEqual(counters.scaled, 1)
        XCTAssertEqual(counters.submitted, 2)
    }

    func testFailedResizeOrPoolDropAdvancesToNewestWaitingFrame() {
        for poolDrop in [false, true] {
            let backend = ManualBackend()
            backend.result = { _ in
                if poolDrop { backend.poolDrops += 1 }
                return nil
            }
            let delivered = Delivered()
            let resizer = ViewerFrameResizer(backend: backend, fallback: nil) { buffer, sequence, _ in
                delivered.append(buffer, sequence)
            }
            resizer.setTarget(Dimensions(width: 2, height: 2))
            let frame = makeBuffer(width: 4, height: 4, format: kCVPixelFormatType_32BGRA)
            resizer.submit(frame)
            backend.waitForRequest()
            resizer.submit(frame)
            resizer.submit(frame)
            backend.completeNext()
            backend.waitForRequest()
            backend.result = { $0 }
            backend.completeNext()
            delivered.waitForFrame()

            XCTAssertEqual(delivered.sequences, [3])
            let counters = resizer.currentCounters()
            XCTAssertEqual(counters.submitted, 3)
            XCTAssertEqual(counters.replaced, 1)
            XCTAssertEqual(counters.scaled, 1)
            XCTAssertEqual(counters.failures, poolDrop ? 0 : 1)
            XCTAssertEqual(counters.poolDrops, poolDrop ? 1 : 0)
            XCTAssertEqual(counters.backendSwitches, 0)
        }
    }

    func testRepeatedFailuresMoveToTheFallbackBackend() {
        let failing = ManualBackend(name: "failing")
        failing.result = { _ in nil }
        let fallback = ManualBackend(name: "fallback")
        let delivered = Delivered()
        let resizer = ViewerFrameResizer(backend: failing, fallback: fallback) { buffer, sequence, _ in
            delivered.append(buffer, sequence)
        }
        resizer.setTarget(Dimensions(width: 32, height: 64))
        let frame = makeBuffer(width: 64, height: 128, format: kCVPixelFormatType_420YpCbCr8BiPlanarVideoRange)
        failing.poolDrops = 2

        for _ in 0..<ViewerFrameResizer.failuresBeforeFallback {
            resizer.submit(frame)
            failing.waitForRequest()
            failing.completeNext()
            _ = resizer.currentCounters()
        }
        XCTAssertTrue(delivered.sequences.isEmpty)
        XCTAssertEqual(resizer.currentCounters().backend, "fallback")
        XCTAssertEqual(resizer.currentCounters().poolDrops, 2)

        resizer.submit(frame)
        fallback.waitForRequest()
        XCTAssertEqual(fallback.requests.count, 1)
        fallback.completeNext()
        delivered.waitForFrame()
        fallback.poolDrops = 1
        XCTAssertEqual(delivered.sequences, [UInt64(ViewerFrameResizer.failuresBeforeFallback + 1)])
        let counters = resizer.currentCounters()
        XCTAssertEqual(counters.failures, UInt64(ViewerFrameResizer.failuresBeforeFallback))
        XCTAssertEqual(counters.backendSwitches, 1)
        XCTAssertEqual(counters.poolDrops, 3)
    }

    func testPoolPressureDropsFramesWithoutSwitchingBackends() {
        let primary = ManualBackend(name: "primary")
        primary.result = { _ in primary.poolDrops += 1; return nil }
        let fallback = ManualBackend(name: "fallback")
        let delivered = Delivered()
        let resizer = ViewerFrameResizer(backend: primary, fallback: fallback) { buffer, sequence, _ in
            delivered.append(buffer, sequence)
        }
        resizer.setTarget(Dimensions(width: 32, height: 64))
        let frame = makeBuffer(width: 64, height: 128,
                               format: kCVPixelFormatType_420YpCbCr8BiPlanarVideoRange)

        for _ in 0..<ViewerFrameResizer.failuresBeforeFallback {
            resizer.submit(frame)
            primary.waitForRequest()
            primary.completeNext()
            _ = resizer.currentCounters()
        }
        XCTAssertEqual(resizer.currentCounters().backend, "primary")
        XCTAssertEqual(resizer.currentCounters().poolDrops,
                       UInt64(ViewerFrameResizer.failuresBeforeFallback))
        XCTAssertEqual(resizer.currentCounters().failures, 0)

        primary.result = { $0 }
        resizer.submit(frame)
        primary.waitForRequest()
        primary.completeNext()
        delivered.waitForFrame()
        XCTAssertEqual(delivered.sequences, [UInt64(ViewerFrameResizer.failuresBeforeFallback + 1)])
        XCTAssertEqual(resizer.currentCounters().backendSwitches, 0)
        XCTAssertTrue(fallback.requests.isEmpty)
    }

    func testUnsupportedFramesUseTheFallbackWithoutCountingAFailure() {
        let primary = ManualBackend(name: "primary")
        primary.supported = { CVPixelBufferGetPixelFormatType($0) != kCVPixelFormatType_32BGRA }
        let fallback = ManualBackend(name: "fallback")
        let delivered = Delivered()
        let resizer = ViewerFrameResizer(backend: primary, fallback: fallback) { buffer, sequence, _ in
            delivered.append(buffer, sequence)
        }
        resizer.setTarget(Dimensions(width: 32, height: 64))
        let bgra = makeBuffer(width: 64, height: 128, format: kCVPixelFormatType_32BGRA)
        let planar = makeBuffer(width: 64, height: 128, format: kCVPixelFormatType_420YpCbCr8BiPlanarVideoRange)

        resizer.submit(bgra)
        fallback.waitForRequest()
        XCTAssertEqual(fallback.requests.count, 1)
        XCTAssertTrue(primary.requests.isEmpty)
        fallback.completeNext()
        delivered.waitForFrame()
        resizer.submit(planar)
        primary.waitForRequest()
        XCTAssertEqual(primary.requests.count, 1)
        primary.completeNext()
        delivered.waitForFrame()

        XCTAssertEqual(delivered.sequences, [1, 2])
        let counters = resizer.currentCounters()
        XCTAssertEqual(counters.unsupported, 1)
        XCTAssertEqual(counters.failures, 0)
        XCTAssertEqual(counters.backend, "primary")
    }

    func testMetalBackendScalesToTheCanvasAndLetterboxesWithBars() throws {
        guard let backend = MetalResizeBackend(maxBuffers: 4) else {
            throw XCTSkip("Metal is not available on this host")
        }
        let source = makeBuffer(width: 120, height: 240, format: kCVPixelFormatType_420YpCbCr8BiPlanarVideoRange)
        fill(source, luma: 235, chroma: 64)

        // Same aspect: the whole canvas is picture.
        let fit = try XCTUnwrap(resize(source, to: Dimensions(width: 60, height: 120), with: backend))
        XCTAssertEqual(fit.dimensions, Dimensions(width: 60, height: 120))
        XCTAssertEqual(luma(fit, x: 30, y: 60), 235, accuracy: 2)
        XCTAssertEqual(luma(fit, x: 1, y: 1), 235, accuracy: 2)
        XCTAssertEqual(chroma(fit, x: 15, y: 30), 64, accuracy: 2)

        // Wider canvas: the picture sits centered between bars.
        let boxed = try XCTUnwrap(resize(source, to: Dimensions(width: 160, height: 120), with: backend))
        XCTAssertEqual(boxed.dimensions, Dimensions(width: 160, height: 120))
        XCTAssertEqual(luma(boxed, x: 80, y: 60), 235, accuracy: 2, "picture in the middle")
        XCTAssertEqual(luma(boxed, x: 10, y: 60), 16, accuracy: 1, "left bar")
        XCTAssertEqual(luma(boxed, x: 150, y: 60), 16, accuracy: 1, "right bar")
        XCTAssertEqual(chroma(boxed, x: 5, y: 30), 128, accuracy: 1, "bars are neutral")
        XCTAssertEqual(chroma(boxed, x: 40, y: 30), 64, accuracy: 2)
    }

    func testMetalBackendPoolIsBounded() throws {
        guard let backend = MetalResizeBackend(maxBuffers: 3) else {
            throw XCTSkip("Metal is not available on this host")
        }
        let source = makeBuffer(width: 120, height: 240, format: kCVPixelFormatType_420YpCbCr8BiPlanarVideoRange)
        var retained: [CVPixelBuffer] = []
        var lost = 0
        for _ in 0..<6 {
            if let output = resize(source, to: Dimensions(width: 60, height: 120), with: backend) {
                retained.append(output)
            } else {
                lost += 1
            }
        }
        XCTAssertEqual(retained.count, 3)
        XCTAssertEqual(lost, 3)
        XCTAssertEqual(backend.poolDrops, 3)
    }

    // MARK: - Helpers

    private func makeBuffer(width: Int, height: Int, format: OSType) -> CVPixelBuffer {
        var buffer: CVPixelBuffer?
        let attributes: [String: Any] = [
            kCVPixelBufferPixelFormatTypeKey as String: format,
            kCVPixelBufferWidthKey as String: width,
            kCVPixelBufferHeightKey as String: height,
            kCVPixelBufferIOSurfacePropertiesKey as String: [:],
        ]
        XCTAssertEqual(CVPixelBufferCreate(kCFAllocatorDefault, width, height, format,
                                           attributes as CFDictionary, &buffer), kCVReturnSuccess)
        return buffer!
    }

    private func resize(_ source: CVPixelBuffer, to target: Dimensions,
                        with backend: ViewerResizeBackend) -> CVPixelBuffer? {
        let done = expectation(description: "resize")
        var result: CVPixelBuffer?
        backend.resize(source, to: target) { output in
            result = output
            done.fulfill()
        }
        wait(for: [done], timeout: 5)
        return result
    }

    private func fill(_ buffer: CVPixelBuffer, luma: UInt8, chroma: UInt8) {
        CVPixelBufferLockBaseAddress(buffer, [])
        memset(CVPixelBufferGetBaseAddressOfPlane(buffer, 0), Int32(luma),
               CVPixelBufferGetBytesPerRowOfPlane(buffer, 0) * CVPixelBufferGetHeightOfPlane(buffer, 0))
        memset(CVPixelBufferGetBaseAddressOfPlane(buffer, 1), Int32(chroma),
               CVPixelBufferGetBytesPerRowOfPlane(buffer, 1) * CVPixelBufferGetHeightOfPlane(buffer, 1))
        CVPixelBufferUnlockBaseAddress(buffer, [])
    }

    private func luma(_ buffer: CVPixelBuffer, x: Int, y: Int) -> Double {
        CVPixelBufferLockBaseAddress(buffer, .readOnly)
        defer { CVPixelBufferUnlockBaseAddress(buffer, .readOnly) }
        let base = CVPixelBufferGetBaseAddressOfPlane(buffer, 0)!.assumingMemoryBound(to: UInt8.self)
        return Double(base[y * CVPixelBufferGetBytesPerRowOfPlane(buffer, 0) + x])
    }

    private func chroma(_ buffer: CVPixelBuffer, x: Int, y: Int) -> Double {
        CVPixelBufferLockBaseAddress(buffer, .readOnly)
        defer { CVPixelBufferUnlockBaseAddress(buffer, .readOnly) }
        let base = CVPixelBufferGetBaseAddressOfPlane(buffer, 1)!.assumingMemoryBound(to: UInt8.self)
        return Double(base[y * CVPixelBufferGetBytesPerRowOfPlane(buffer, 1) + x * 2])
    }
}
