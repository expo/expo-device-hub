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

    func testMetalBackendScalesToTheCanvasAndRepeatsTheEdgeIntoUnusedColumns() throws {
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

        // Wider canvas: the picture starts at the left edge; the unused columns on the right
        // repeat its edge, so no black shows where a client's scaling reaches past the picture.
        let boxed = try XCTUnwrap(resize(source, to: Dimensions(width: 160, height: 120), with: backend))
        XCTAssertEqual(boxed.dimensions, Dimensions(width: 160, height: 120))
        XCTAssertEqual(luma(boxed, x: 1, y: 60), 235, accuracy: 2, "picture at the left edge")
        XCTAssertEqual(luma(boxed, x: 58, y: 60), 235, accuracy: 2)
        XCTAssertEqual(luma(boxed, x: 100, y: 60), 235, accuracy: 2, "unused columns repeat the edge")
        XCTAssertEqual(chroma(boxed, x: 15, y: 30), 64, accuracy: 2)
        XCTAssertEqual(chroma(boxed, x: 60, y: 30), 64, accuracy: 2)
    }

    func testMetalBackendKeepsBothPictureEdges() throws {
        guard let backend = MetalResizeBackend(maxBuffers: 4) else {
            throw XCTSkip("Metal is not available on this host")
        }
        try assertKeepsBothPictureEdges(backend)
    }

    func testVideoToolboxBackendKeepsBothPictureEdges() throws {
        try assertKeepsBothPictureEdges(LetterboxResizeBackend(letterboxer: PixelBufferLetterboxer()))
    }

    func testCPUBackendKeepsBothPictureEdges() throws {
        try assertKeepsBothPictureEdges(LetterboxResizeBackend(
            letterboxer: PixelBufferLetterboxer(preferCPU: true), name: "cpu"))
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

    func testFailedTopLeftTransferLatchesToTheCPUPathWithoutRetrying() throws {
        var attempts = 0
        let letterboxer = PixelBufferLetterboxer(transferImage: { _, _, _ in
            attempts += 1
            return -1
        })
        let source = makeBuffer(width: 1_398, height: 2_034,
                                format: kCVPixelFormatType_420YpCbCr8BiPlanarVideoRange)
        fill(source, luma: 128, chroma: 128)
        fillColumns(source, from: 1_374, to: 1_398, luma: 235)

        // The first frame tries VideoToolbox once, then uses the CPU path, still top-left.
        let first = try XCTUnwrap(letterboxer.place(source, width: 798, height: 1_136, topLeft: true))
        XCTAssertEqual(attempts, 1)
        XCTAssertEqual(letterboxer.cpuFrames, 1)
        XCTAssertEqual(letterboxer.transferFrames, 0)
        XCTAssertEqual(luma(first, x: 780, y: 568), 235, accuracy: 3, "right edge kept")
        XCTAssertEqual(luma(first, x: 790, y: 568), 235, accuracy: 3, "edge repeated, not centered bars")

        // Later frames skip VideoToolbox, top-left and centered alike.
        let second = try XCTUnwrap(letterboxer.place(source, width: 798, height: 1_136, topLeft: true))
        _ = try XCTUnwrap(letterboxer.place(source, width: 798, height: 1_136))
        XCTAssertEqual(attempts, 1, "the failed transfer is not retried")
        XCTAssertEqual(letterboxer.cpuFrames, 3)
        XCTAssertEqual(luma(second, x: 790, y: 568), 235, accuracy: 3)
    }

    func testFailedTopLeftTransferWithoutCPUFallbackDropsFramesWithoutRetrying() {
        var attempts = 0
        let letterboxer = PixelBufferLetterboxer(allowCPUFallback: false, transferImage: { _, _, _ in
            attempts += 1
            return -1
        })
        let source = makeBuffer(width: 1_398, height: 2_034,
                                format: kCVPixelFormatType_420YpCbCr8BiPlanarVideoRange)

        XCTAssertNil(letterboxer.place(source, width: 798, height: 1_136, topLeft: true))
        XCTAssertNil(letterboxer.place(source, width: 798, height: 1_136, topLeft: true))
        XCTAssertEqual(attempts, 1, "the failed transfer is not retried")
        XCTAssertEqual(letterboxer.cpuFrames, 0)
    }

    // MARK: - Helpers

    /// The iPhone Duo cover screen in the canvas sized for its inner screen. The source's left
    /// and right 24 columns are marked, so a stretched or clipped picture loses a mark.
    private func assertKeepsBothPictureEdges(_ backend: ViewerResizeBackend,
                                             file: StaticString = #filePath, line: UInt = #line) throws {
        let source = makeBuffer(width: 1_398, height: 2_034,
                                format: kCVPixelFormatType_420YpCbCr8BiPlanarVideoRange)
        fill(source, luma: 128, chroma: 128)
        fillColumns(source, from: 0, to: 24, luma: 60)
        fillColumns(source, from: 1_374, to: 1_398, luma: 235)

        let output = try XCTUnwrap(resize(source, to: Dimensions(width: 798, height: 1_136), with: backend),
                                   file: file, line: line)
        XCTAssertEqual(output.dimensions, Dimensions(width: 798, height: 1_136), file: file, line: line)
        // The picture is 780.8 columns wide, drawn into 782 from x = 0.
        XCTAssertEqual(luma(output, x: 1, y: 568), 60, accuracy: 3, "left mark at the left edge", file: file, line: line)
        XCTAssertEqual(luma(output, x: 11, y: 568), 60, accuracy: 3, file: file, line: line)
        XCTAssertEqual(luma(output, x: 390, y: 568), 128, accuracy: 3, file: file, line: line)
        XCTAssertEqual(luma(output, x: 772, y: 568), 235, accuracy: 3, "right mark is kept", file: file, line: line)
        XCTAssertEqual(luma(output, x: 780, y: 568), 235, accuracy: 3, file: file, line: line)
        XCTAssertEqual(luma(output, x: 790, y: 568), 235, accuracy: 3, "unused columns repeat the right edge", file: file, line: line)
        XCTAssertEqual(luma(output, x: 797, y: 568), 235, accuracy: 3, file: file, line: line)
        XCTAssertEqual(chroma(output, x: 396, y: 284), 128, accuracy: 2, file: file, line: line)
        XCTAssertEqual(luma(output, x: 390, y: 1_134), 128, accuracy: 3, "full height", file: file, line: line)
    }

    private func fillColumns(_ buffer: CVPixelBuffer, from start: Int, to end: Int, luma: UInt8) {
        CVPixelBufferLockBaseAddress(buffer, [])
        defer { CVPixelBufferUnlockBaseAddress(buffer, []) }
        let base = CVPixelBufferGetBaseAddressOfPlane(buffer, 0)!.assumingMemoryBound(to: UInt8.self)
        let stride = CVPixelBufferGetBytesPerRowOfPlane(buffer, 0)
        for y in 0..<CVPixelBufferGetHeightOfPlane(buffer, 0) {
            for x in start..<end { base[y * stride + x] = luma }
        }
    }

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
