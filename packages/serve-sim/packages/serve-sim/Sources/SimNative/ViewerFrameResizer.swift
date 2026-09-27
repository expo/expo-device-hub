import CoreVideo
import Foundation
import Metal
import MetalPerformanceShaders
import StreamingPolicy

/// Produces a frame of the requested size from a captured frame, aspect-fit with
/// bars where the shapes differ. A backend does the pixel work; the resizer
/// owns ordering, replacement, and counting.
protocol ViewerResizeBackend: AnyObject {
    var name: String { get }
    var poolDrops: UInt64 { get }
    func supports(_ source: CVPixelBuffer) -> Bool
    /// Calls `completion` exactly once, on any thread. Nil means the frame is lost.
    func resize(_ source: CVPixelBuffer, to target: Dimensions,
                completion: @escaping (CVPixelBuffer?) -> Void)
}

/// Cumulative counters. Every field only grows, so a poller can difference two reads.
struct ViewerResizeCounters: Codable {
    var backend: String
    var submitted: UInt64 = 0
    var passedThrough: UInt64 = 0
    var scaled: UInt64 = 0
    /// Frames that waited behind an in-flight resize and were replaced by a newer frame.
    var replaced: UInt64 = 0
    var poolDrops: UInt64 = 0
    var failures: UInt64 = 0
    /// Frames the primary backend cannot read, resized by the fallback instead.
    var unsupported: UInt64 = 0
    var backendSwitches: UInt64 = 0
    /// Time from submission to the start of the resize, and the resize itself.
    var waitSumMs: Double = 0
    var waitMaxMs: Double = 0
    var resizeSumMs: Double = 0
    var resizeMaxMs: Double = 0
}

/// Scales or letterboxes captured frames to the shared viewer canvas on its own
/// queue, so the WebRTC frame pump never waits on a resize.
///
/// Latest wins: a frame submitted while one is in flight replaces the waiting
/// frame. Output buffers come from a bounded pool in the backend; a full pool
/// drops the frame. Frames leave in submission order with an increasing
/// sequence number, on the resizer queue.
final class ViewerFrameResizer: @unchecked Sendable {
    private struct Submission {
        let pixelBuffer: CVPixelBuffer
        let sequence: UInt64
        let acceptanceGeneration: UInt64
        let submittedNs: UInt64
    }

    /// Consecutive failures before the resizer moves to the fallback backend.
    static let failuresBeforeFallback = 3

    private let queue = DispatchQueue(label: "viewer-resize", qos: .userInteractive)
    private let output: (CVPixelBuffer, UInt64, UInt64) -> Void
    private let lock = NSLock()
    private var nextSequence: UInt64 = 0
    private var target: Dimensions?
    // Confined to `queue`.
    private var backend: ViewerResizeBackend
    private var fallback: ViewerResizeBackend?
    private var pending: Submission?
    private var inFlight = false
    private var consecutiveFailures = 0
    private var retiredPoolDrops: UInt64 = 0
    private var counters: ViewerResizeCounters

    init(backend: ViewerResizeBackend, fallback: ViewerResizeBackend?,
         output: @escaping (CVPixelBuffer, UInt64, UInt64) -> Void) {
        self.backend = backend
        self.fallback = fallback
        self.output = output
        counters = ViewerResizeCounters(backend: backend.name)
    }

    /// The default backend order for this host: Metal, then the VideoToolbox
    /// transfer with its own CPU fallback. `SERVE_SIM_VIEWER_RESIZE=metal|videotoolbox|cpu`
    /// pins one backend for measurements.
    static func makeDefault(output: @escaping (CVPixelBuffer, UInt64, UInt64) -> Void) -> ViewerFrameResizer {
        let letterbox = LetterboxResizeBackend(letterboxer: PixelBufferLetterboxer(maxBuffers: 4))
        switch ProcessInfo.processInfo.environment["SERVE_SIM_VIEWER_RESIZE"] {
        case "cpu":
            let cpu = LetterboxResizeBackend(
                letterboxer: PixelBufferLetterboxer(maxBuffers: 4, preferCPU: true), name: "cpu"
            )
            return ViewerFrameResizer(backend: cpu, fallback: nil, output: output)
        case "videotoolbox":
            return ViewerFrameResizer(backend: letterbox, fallback: nil, output: output)
        default:
            if let metal = MetalResizeBackend(maxBuffers: 4) {
                return ViewerFrameResizer(backend: metal, fallback: letterbox, output: output)
            }
            return ViewerFrameResizer(backend: letterbox, fallback: nil, output: output)
        }
    }

    /// Nil passes every frame through unchanged.
    func setTarget(_ dimensions: Dimensions?) {
        lock.lock()
        target = dimensions.flatMap { $0.width > 0 && $0.height > 0 ? $0 : nil }
        lock.unlock()
    }

    func submit(_ pixelBuffer: CVPixelBuffer, acceptanceGeneration: UInt64 = 0) {
        lock.lock()
        nextSequence &+= 1
        let submission = Submission(pixelBuffer: pixelBuffer, sequence: nextSequence,
                                    acceptanceGeneration: acceptanceGeneration,
                                    submittedNs: DispatchTime.now().uptimeNanoseconds)
        lock.unlock()
        queue.async { self.enqueue(submission) }
    }

    func currentCounters() -> ViewerResizeCounters {
        queue.sync {
            var value = counters
            value.poolDrops = retiredPoolDrops + backend.poolDrops + (fallback?.poolDrops ?? 0)
            return value
        }
    }

    private func enqueue(_ submission: Submission) {
        counters.submitted &+= 1
        if inFlight {
            if pending != nil { counters.replaced &+= 1 }
            pending = submission
            return
        }
        process(submission)
    }

    private func process(_ submission: Submission) {
        lock.lock()
        let target = self.target
        lock.unlock()
        guard let target, submission.pixelBuffer.dimensions != target else {
            counters.passedThrough &+= 1
            output(submission.pixelBuffer, submission.sequence, submission.acceptanceGeneration)
            return
        }
        let worker: ViewerResizeBackend
        let usedPrimary: Bool
        if backend.supports(submission.pixelBuffer) {
            worker = backend
            usedPrimary = true
        } else if let fallback, fallback.supports(submission.pixelBuffer) {
            worker = fallback
            usedPrimary = false
            counters.unsupported &+= 1
        } else {
            counters.failures &+= 1
            return
        }
        let startNs = DispatchTime.now().uptimeNanoseconds
        let waitMs = Double(startNs &- submission.submittedNs) / 1_000_000
        counters.waitSumMs += waitMs
        counters.waitMaxMs = max(counters.waitMaxMs, waitMs)
        inFlight = true
        let poolDropsBefore = worker.poolDrops
        worker.resize(submission.pixelBuffer, to: target) { [weak self] result in
            let finishedNs = DispatchTime.now().uptimeNanoseconds
            self?.queue.async {
                self?.finish(submission, result: result, usedPrimary: usedPrimary,
                             poolDrop: worker.poolDrops > poolDropsBefore,
                             resizeMs: Double(finishedNs &- startNs) / 1_000_000)
            }
        }
    }

    private func finish(_ submission: Submission, result: CVPixelBuffer?, usedPrimary: Bool,
                        poolDrop: Bool, resizeMs: Double) {
        inFlight = false
        counters.resizeSumMs += resizeMs
        counters.resizeMaxMs = max(counters.resizeMaxMs, resizeMs)
        if let result {
            if usedPrimary { consecutiveFailures = 0 }
            counters.scaled &+= 1
            output(result, submission.sequence, submission.acceptanceGeneration)
        } else if !poolDrop {
            counters.failures &+= 1
            if usedPrimary { consecutiveFailures += 1 }
            if usedPrimary, consecutiveFailures >= Self.failuresBeforeFallback, let fallback {
                print("[webrtc] viewer resize backend \(backend.name) failed \(consecutiveFailures) times; using \(fallback.name)")
                retiredPoolDrops &+= backend.poolDrops
                backend = fallback
                self.fallback = nil
                consecutiveFailures = 0
                counters.backend = backend.name
                counters.backendSwitches &+= 1
            }
        }
        if let next = pending {
            pending = nil
            process(next)
        }
    }
}

/// The VideoToolbox transfer path, with the letterboxer's own CPU fallback.
final class LetterboxResizeBackend: ViewerResizeBackend {
    private let letterboxer: PixelBufferLetterboxer
    let name: String

    init(letterboxer: PixelBufferLetterboxer, name: String = "videotoolbox") {
        self.letterboxer = letterboxer
        self.name = name
    }

    var poolDrops: UInt64 { letterboxer.poolDrops }

    func supports(_ source: CVPixelBuffer) -> Bool {
        PixelBufferLetterboxer.supports(CVPixelBufferGetPixelFormatType(source))
    }

    func resize(_ source: CVPixelBuffer, to target: Dimensions,
                completion: @escaping (CVPixelBuffer?) -> Void) {
        completion(letterboxer.place(source, width: target.width, height: target.height))
    }
}

/// Bilinear scale of the Y and CbCr planes on the GPU. Bars, when the shapes
/// differ, come from scaling a constant 2×2 plane over the whole output first.
/// The bars are video-range black (Y 16), the range the capture copy uses.
final class MetalResizeBackend: ViewerResizeBackend {
    let name = "metal"
    private(set) var poolDrops: UInt64 = 0
    private let device: MTLDevice
    private let commandQueue: MTLCommandQueue
    private let textureCache: CVMetalTextureCache
    private let scale: MPSImageBilinearScale
    private let barsY: MTLTexture
    private let barsCbCr: MTLTexture
    private let maxBuffers: Int
    private var pool: CVPixelBufferPool?
    private var poolDimensions = Dimensions(width: 0, height: 0)
    private var poolFormat: OSType = 0

    private static let supportedFormats: Set<OSType> = [
        kCVPixelFormatType_420YpCbCr8BiPlanarVideoRange,
        kCVPixelFormatType_420YpCbCr8BiPlanarFullRange,
    ]

    init?(maxBuffers: Int) {
        guard let device = MTLCreateSystemDefaultDevice(), MPSSupportsMTLDevice(device),
              let commandQueue = device.makeCommandQueue() else { return nil }
        var cache: CVMetalTextureCache?
        guard CVMetalTextureCacheCreate(kCFAllocatorDefault, nil, device, nil, &cache) == kCVReturnSuccess,
              let cache else { return nil }
        guard let barsY = Self.constantTexture(device: device, format: .r8Unorm, bytes: [16, 16, 16, 16], bytesPerRow: 2),
              let barsCbCr = Self.constantTexture(device: device, format: .rg8Unorm,
                                                  bytes: [128, 128, 128, 128, 128, 128, 128, 128], bytesPerRow: 4)
        else { return nil }
        self.device = device
        self.commandQueue = commandQueue
        textureCache = cache
        scale = MPSImageBilinearScale(device: device)
        // Clamp, not zero: the default blends the outermost source pixels with black.
        scale.edgeMode = .clamp
        self.barsY = barsY
        self.barsCbCr = barsCbCr
        self.maxBuffers = maxBuffers
    }

    func supports(_ source: CVPixelBuffer) -> Bool {
        Self.supportedFormats.contains(CVPixelBufferGetPixelFormatType(source))
            && CVPixelBufferGetPlaneCount(source) == 2
    }

    func resize(_ source: CVPixelBuffer, to target: Dimensions,
                completion: @escaping (CVPixelBuffer?) -> Void) {
        let format = CVPixelBufferGetPixelFormatType(source)
        guard supports(source), let pool = pool(dimensions: target, format: format) else {
            completion(nil)
            return
        }
        var output: CVPixelBuffer?
        let limit = [kCVPixelBufferPoolAllocationThresholdKey as String: maxBuffers] as CFDictionary
        guard CVPixelBufferPoolCreatePixelBufferWithAuxAttributes(kCFAllocatorDefault, pool, limit, &output)
                == kCVReturnSuccess, let output else {
            poolDrops &+= 1
            completion(nil)
            return
        }
        let placement = LetterboxPlacement(
            sourceWidth: CVPixelBufferGetWidth(source), sourceHeight: CVPixelBufferGetHeight(source),
            canvasWidth: target.width, canvasHeight: target.height
        )
        guard placement.width > 0, placement.height > 0,
              let sourceY = texture(source, plane: 0), let sourceCbCr = texture(source, plane: 1),
              let outputY = texture(output, plane: 0), let outputCbCr = texture(output, plane: 1),
              let commandBuffer = commandQueue.makeCommandBuffer() else {
            completion(nil)
            return
        }
        let fillsCanvas = placement.x == 0 && placement.y == 0
            && placement.width == target.width && placement.height == target.height
        if !fillsCanvas {
            encodeScale(commandBuffer, from: barsY, to: outputY.texture, region: nil)
            encodeScale(commandBuffer, from: barsCbCr, to: outputCbCr.texture, region: nil)
        }
        encodeScale(commandBuffer, from: sourceY.texture, to: outputY.texture,
                    region: fillsCanvas ? nil : MTLRegionMake2D(placement.x, placement.y, placement.width, placement.height))
        encodeScale(commandBuffer, from: sourceCbCr.texture, to: outputCbCr.texture,
                    region: fillsCanvas ? nil : MTLRegionMake2D(placement.x / 2, placement.y / 2, placement.width / 2, placement.height / 2))
        // The CVMetalTexture wrappers must outlive the GPU work.
        let retained = [sourceY, sourceCbCr, outputY, outputCbCr]
        commandBuffer.addCompletedHandler { buffer in
            withExtendedLifetime(retained) {}
            withExtendedLifetime(source) {}
            completion(buffer.status == .completed ? output : nil)
        }
        commandBuffer.commit()
    }

    /// Fits `source` into `region` of the destination, or into the whole destination.
    /// With no scale transform, MPS fits the source to the clip rect.
    private func encodeScale(_ commandBuffer: MTLCommandBuffer, from source: MTLTexture,
                             to destination: MTLTexture, region: MTLRegion?) {
        scale.clipRect = region ?? MTLRegionMake2D(0, 0, destination.width, destination.height)
        scale.encode(commandBuffer: commandBuffer, sourceTexture: source, destinationTexture: destination)
    }

    private func texture(_ buffer: CVPixelBuffer, plane: Int) -> (texture: MTLTexture, wrapper: CVMetalTexture)? {
        var wrapper: CVMetalTexture?
        let status = CVMetalTextureCacheCreateTextureFromImage(
            kCFAllocatorDefault, textureCache, buffer, nil, plane == 0 ? .r8Unorm : .rg8Unorm,
            CVPixelBufferGetWidthOfPlane(buffer, plane), CVPixelBufferGetHeightOfPlane(buffer, plane),
            plane, &wrapper
        )
        guard status == kCVReturnSuccess, let wrapper, let texture = CVMetalTextureGetTexture(wrapper) else {
            return nil
        }
        return (texture, wrapper)
    }

    private func pool(dimensions: Dimensions, format: OSType) -> CVPixelBufferPool? {
        if let pool, poolDimensions == dimensions, poolFormat == format { return pool }
        let attributes: [String: Any] = [
            kCVPixelBufferPixelFormatTypeKey as String: format,
            kCVPixelBufferWidthKey as String: dimensions.width,
            kCVPixelBufferHeightKey as String: dimensions.height,
            kCVPixelBufferIOSurfacePropertiesKey as String: [:],
            kCVPixelBufferMetalCompatibilityKey as String: true,
        ]
        var next: CVPixelBufferPool?
        guard CVPixelBufferPoolCreate(kCFAllocatorDefault, nil, attributes as CFDictionary, &next) == kCVReturnSuccess
        else { return nil }
        pool = next
        poolDimensions = dimensions
        poolFormat = format
        return next
    }

    private static func constantTexture(device: MTLDevice, format: MTLPixelFormat,
                                        bytes: [UInt8], bytesPerRow: Int) -> MTLTexture? {
        let descriptor = MTLTextureDescriptor.texture2DDescriptor(pixelFormat: format, width: 2, height: 2, mipmapped: false)
        descriptor.usage = .shaderRead
        guard let texture = device.makeTexture(descriptor: descriptor) else { return nil }
        bytes.withUnsafeBytes { raw in
            texture.replace(region: MTLRegionMake2D(0, 0, 2, 2), mipmapLevel: 0,
                            withBytes: raw.baseAddress!, bytesPerRow: bytesPerRow)
        }
        return texture
    }
}
