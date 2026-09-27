import CoreVideo
import XCTest
@testable import SimNative

/// A backend the test completes by hand, so replacement and ordering are deterministic.
private final class ManualBackend: ViewerResizeBackend {
    let name: String
    var poolDrops: UInt64 = 0
    private let lock = NSLock()
    private var waiting: [(source: CVPixelBuffer, completion: (CVPixelBuffer?) -> Void)] = []
    private(set) var requests: [CVPixelBuffer] = []
    var result: (CVPixelBuffer) -> CVPixelBuffer? = { $0 }
    var supported: (CVPixelBuffer) -> Bool = { _ in true }

    init(name: String = "manual") { self.name = name }

    func supports(_ source: CVPixelBuffer) -> Bool { supported(source) }

    func resize(_ source: CVPixelBuffer, to target: Dimensions,
                completion: @escaping (CVPixelBuffer?) -> Void) {
        lock.lock()
        requests.append(source)
        waiting.append((source, completion))
        lock.unlock()
    }

    func completeNext() {
        lock.lock()
        let next = waiting.removeFirst()
        lock.unlock()
        next.completion(result(next.source))
    }
}

private final class Delivered: @unchecked Sendable {
    private let lock = NSLock()
    private var items: [(CVPixelBuffer, UInt64)] = []

    func append(_ buffer: CVPixelBuffer, _ sequence: UInt64) {
        lock.lock(); items.append((buffer, sequence)); lock.unlock()
    }

    var sequences: [UInt64] { lock.lock(); defer { lock.unlock() }; return items.map(\.1) }
    var buffers: [CVPixelBuffer] { lock.lock(); defer { lock.unlock() }; return items.map(\.0) }
}

final class ViewerFrameResizerTests: XCTestCase {
    private func settle() { Thread.sleep(forTimeInterval: 0.05) }

    func testPassesThroughWhenSizeMatchesOrNoTarget() {
        let backend = ManualBackend()
        let delivered = Delivered()
        let resizer = ViewerFrameResizer(backend: backend, fallback: nil) { buffer, sequence, _ in
            delivered.append(buffer, sequence)
        }
        let frame = makeBuffer(width: 64, height: 128, format: kCVPixelFormatType_420YpCbCr8BiPlanarVideoRange)

        resizer.submit(frame)
        resizer.setTarget(Dimensions(width: 64, height: 128))
        resizer.submit(frame)
        settle()

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
        settle()
        resizer.submit(frames[1])
        resizer.submit(frames[2])
        settle()
        XCTAssertEqual(backend.requests.count, 1, "the second and third frames wait behind the first")

        backend.completeNext()
        settle()
        XCTAssertEqual(delivered.sequences, [1])
        XCTAssertEqual(backend.requests.count, 2)
        XCTAssertTrue(backend.requests[1] === frames[2], "the newest waiting frame is resized, the older one is dropped")

        backend.completeNext()
        settle()
        XCTAssertEqual(delivered.sequences, [1, 3])
        let counters = resizer.currentCounters()
        XCTAssertEqual(counters.scaled, 2)
        XCTAssertEqual(counters.replaced, 1)
        XCTAssertEqual(counters.submitted, 3)
    }

    func testInFlightCompletionKeepsItsAcceptanceGeneration() {
        let backend = ManualBackend()
        var generations: [UInt64] = []
        let resizer = ViewerFrameResizer(backend: backend, fallback: nil) { _, _, generation in
            generations.append(generation)
        }
        resizer.setTarget(Dimensions(width: 32, height: 64))
        let frame = makeBuffer(width: 64, height: 128,
                               format: kCVPixelFormatType_420YpCbCr8BiPlanarVideoRange)
        resizer.submit(frame, acceptanceGeneration: 1)
        settle()
        resizer.submit(frame, acceptanceGeneration: 2)
        settle()

        backend.completeNext()
        settle()
        backend.completeNext()
        settle()
        XCTAssertEqual(generations, [1, 2])
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
            settle()
            failing.completeNext()
            settle()
        }
        XCTAssertTrue(delivered.sequences.isEmpty)
        XCTAssertEqual(resizer.currentCounters().backend, "fallback")
        XCTAssertEqual(resizer.currentCounters().poolDrops, 2)

        resizer.submit(frame)
        settle()
        XCTAssertEqual(fallback.requests.count, 1)
        fallback.completeNext()
        settle()
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
            settle()
            primary.completeNext()
            settle()
        }
        XCTAssertEqual(resizer.currentCounters().backend, "primary")
        XCTAssertEqual(resizer.currentCounters().poolDrops,
                       UInt64(ViewerFrameResizer.failuresBeforeFallback))
        XCTAssertEqual(resizer.currentCounters().failures, 0)

        primary.result = { $0 }
        resizer.submit(frame)
        settle()
        primary.completeNext()
        settle()
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
        settle()
        XCTAssertEqual(fallback.requests.count, 1)
        XCTAssertTrue(primary.requests.isEmpty)
        fallback.completeNext()
        settle()
        resizer.submit(planar)
        settle()
        XCTAssertEqual(primary.requests.count, 1)
        primary.completeNext()
        settle()

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

    /// The even-size copy of an odd-size panel is BGRA. Metal converts it to video-range
    /// 4:2:0 while scaling, with bars, so it never needs the VideoToolbox fallback.
    func testMetalBackendConvertsBGRAWhileScalingAndLetterboxing() throws {
        guard let backend = MetalResizeBackend(maxBuffers: 4) else {
            throw XCTSkip("Metal is not available on this host")
        }
        let source = makeBuffer(width: 120, height: 240, format: kCVPixelFormatType_32BGRA)
        XCTAssertTrue(backend.supports(source))
        // Left half white, right half pure red: luma and chroma are both checked.
        CVPixelBufferLockBaseAddress(source, [])
        let base = CVPixelBufferGetBaseAddress(source)!.assumingMemoryBound(to: UInt8.self)
        let stride = CVPixelBufferGetBytesPerRow(source)
        for y in 0..<240 {
            for x in 0..<120 {
                let p = base + y * stride + x * 4
                let red = x >= 60
                p[0] = red ? 0 : 255; p[1] = red ? 0 : 255; p[2] = 255; p[3] = 255  // B, G, R, A
            }
        }
        CVPixelBufferUnlockBaseAddress(source, [])

        let fit = try XCTUnwrap(resize(source, to: Dimensions(width: 60, height: 120), with: backend))
        XCTAssertEqual(CVPixelBufferGetPixelFormatType(fit), kCVPixelFormatType_420YpCbCr8BiPlanarVideoRange)
        XCTAssertEqual(fit.dimensions, Dimensions(width: 60, height: 120))
        XCTAssertEqual(luma(fit, x: 15, y: 60), 235, accuracy: 2, "white is video-range white")
        XCTAssertEqual(chroma(fit, x: 7, y: 30), 128, accuracy: 2, "white has neutral chroma")
        XCTAssertEqual(luma(fit, x: 45, y: 60), 63, accuracy: 3, "BT.709 red luma")
        XCTAssertEqual(chroma(fit, x: 22, y: 30), 102, accuracy: 3, "BT.709 red Cb")
        XCTAssertEqual(chroma(fit, x: 22, y: 30, plane: 1), 240, accuracy: 3, "BT.709 red Cr")

        let boxed = try XCTUnwrap(resize(source, to: Dimensions(width: 160, height: 120), with: backend))
        XCTAssertEqual(luma(boxed, x: 65, y: 60), 235, accuracy: 2, "picture in the middle")
        XCTAssertEqual(luma(boxed, x: 10, y: 60), 16, accuracy: 1, "left bar")
        XCTAssertEqual(luma(boxed, x: 150, y: 60), 16, accuracy: 1, "right bar")
        XCTAssertEqual(chroma(boxed, x: 5, y: 30), 128, accuracy: 1, "bars are neutral")
        XCTAssertEqual(backend.poolDrops, 0)
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

    /// `plane` 0 reads Cb, 1 reads Cr of the interleaved chroma sample.
    private func chroma(_ buffer: CVPixelBuffer, x: Int, y: Int, plane: Int = 0) -> Double {
        CVPixelBufferLockBaseAddress(buffer, .readOnly)
        defer { CVPixelBufferUnlockBaseAddress(buffer, .readOnly) }
        let base = CVPixelBufferGetBaseAddressOfPlane(buffer, 1)!.assumingMemoryBound(to: UInt8.self)
        return Double(base[y * CVPixelBufferGetBytesPerRowOfPlane(buffer, 1) + x * 2 + plane])
    }
}
