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

    /// BGRA sources (the even-size copy of an odd-size panel while recording) are
    /// scaled and converted to video-range 4:2:0 in one pass by these kernels, bars
    /// included, so they never fall back to the VideoToolbox transfer.
    private let bgraToY: MTLComputePipelineState?
    private let bgraToCbCr: MTLComputePipelineState?
    private static let bgraKernels = """
    #include <metal_stdlib>
    using namespace metal;
    struct Rect { uint x; uint y; uint w; uint h; };
    constexpr sampler bilinear(coord::normalized, filter::linear, address::clamp_to_edge);
    // BT.709 video range, from gamma-encoded RGB, matching the VideoToolbox transfer.
    static inline float3 ycbcr(float3 rgb) {
        float y = 0.2126 * rgb.r + 0.7152 * rgb.g + 0.0722 * rgb.b;
        float cb = (rgb.b - y) / 1.8556;
        float cr = (rgb.r - y) / 1.5748;
        return float3(16.0 / 255.0 + y * 219.0 / 255.0, 0.5 + cb * 224.0 / 255.0, 0.5 + cr * 224.0 / 255.0);
    }
    kernel void bgraToY(texture2d<float, access::sample> src [[texture(0)]],
                        texture2d<float, access::write> dst [[texture(1)]],
                        constant Rect &r [[buffer(0)]],
                        uint2 gid [[thread_position_in_grid]]) {
        if (gid.x >= dst.get_width() || gid.y >= dst.get_height()) return;
        float luma = 16.0 / 255.0;
        if (gid.x >= r.x && gid.y >= r.y && gid.x < r.x + r.w && gid.y < r.y + r.h) {
            float2 uv = float2((float(gid.x - r.x) + 0.5) / float(r.w), (float(gid.y - r.y) + 0.5) / float(r.h));
            luma = ycbcr(src.sample(bilinear, uv).rgb).x;
        }
        dst.write(float4(luma, 0.0, 0.0, 1.0), gid);
    }
    kernel void bgraToCbCr(texture2d<float, access::sample> src [[texture(0)]],
                           texture2d<float, access::write> dst [[texture(1)]],
                           constant Rect &r [[buffer(0)]],
                           uint2 gid [[thread_position_in_grid]]) {
        if (gid.x >= dst.get_width() || gid.y >= dst.get_height()) return;
        float2 chroma = float2(0.5, 0.5);
        // The chroma sample sits at the center of its 2x2 luma block.
        float2 p = float2(gid) * 2.0 + 1.0;
        if (p.x >= float(r.x) && p.y >= float(r.y) && p.x < float(r.x + r.w) && p.y < float(r.y + r.h)) {
            float2 uv = float2((p.x - float(r.x)) / float(r.w), (p.y - float(r.y)) / float(r.h));
            chroma = ycbcr(src.sample(bilinear, uv).rgb).yz;
        }
        dst.write(float4(chroma.x, chroma.y, 0.0, 1.0), gid);
    }
    """

    init?(maxBuffers: Int) {
        guard let device = MTLCreateSystemDefaultDevice(), MPSSupportsMTLDevice(device),
              let commandQueue = device.makeCommandQueue() else { return nil }
        if let library = try? device.makeLibrary(source: Self.bgraKernels, options: nil),
           let yFunction = library.makeFunction(name: "bgraToY"),
           let cbcrFunction = library.makeFunction(name: "bgraToCbCr"),
           let yState = try? device.makeComputePipelineState(function: yFunction),
           let cbcrState = try? device.makeComputePipelineState(function: cbcrFunction) {
            bgraToY = yState
            bgraToCbCr = cbcrState
        } else {
            print("[webrtc] Metal BGRA conversion kernels unavailable; BGRA frames use the fallback")
            bgraToY = nil
            bgraToCbCr = nil
        }
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
        let format = CVPixelBufferGetPixelFormatType(source)
        if format == kCVPixelFormatType_32BGRA {
            // The texture cache needs an IOSurface behind the buffer.
            return bgraToY != nil && bgraToCbCr != nil && CVPixelBufferGetIOSurface(source) != nil
        }
        return Self.supportedFormats.contains(format) && CVPixelBufferGetPlaneCount(source) == 2
    }

    func resize(_ source: CVPixelBuffer, to target: Dimensions,
                completion: @escaping (CVPixelBuffer?) -> Void) {
        let sourceFormat = CVPixelBufferGetPixelFormatType(source)
        let isBGRA = sourceFormat == kCVPixelFormatType_32BGRA
        // BGRA converts to video-range 4:2:0, the range the capture copy uses for the rest.
        let format = isBGRA ? kCVPixelFormatType_420YpCbCr8BiPlanarVideoRange : sourceFormat
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
              let outputY = texture(output, plane: 0), let outputCbCr = texture(output, plane: 1),
              let commandBuffer = commandQueue.makeCommandBuffer() else {
            completion(nil)
            return
        }
        var retained: [CVMetalTexture] = [outputY.wrapper, outputCbCr.wrapper]
        if isBGRA {
            guard let sourceBGRA = texture(source, plane: 0, format: .bgra8Unorm),
                  encodeConvert(commandBuffer, from: sourceBGRA.texture, toY: outputY.texture,
                                cbcr: outputCbCr.texture, placement: placement) else {
                completion(nil)
                return
            }
            retained.append(sourceBGRA.wrapper)
        } else {
            guard let sourceY = texture(source, plane: 0), let sourceCbCr = texture(source, plane: 1) else {
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
            retained.append(contentsOf: [sourceY.wrapper, sourceCbCr.wrapper])
        }
        // The CVMetalTexture wrappers must outlive the GPU work.
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

    /// One compute pass per plane: bilinear sample of the BGRA source into the placement
    /// rectangle, video-range black elsewhere.
    private func encodeConvert(_ commandBuffer: MTLCommandBuffer, from source: MTLTexture,
                               toY outputY: MTLTexture, cbcr outputCbCr: MTLTexture,
                               placement: LetterboxPlacement) -> Bool {
        guard let bgraToY, let bgraToCbCr, let encoder = commandBuffer.makeComputeCommandEncoder() else { return false }
        var rect = (UInt32(placement.x), UInt32(placement.y), UInt32(placement.width), UInt32(placement.height))
        for (state, destination) in [(bgraToY, outputY), (bgraToCbCr, outputCbCr)] {
            encoder.setComputePipelineState(state)
            encoder.setTexture(source, index: 0)
            encoder.setTexture(destination, index: 1)
            encoder.setBytes(&rect, length: MemoryLayout.size(ofValue: rect), index: 0)
            let width = state.threadExecutionWidth
            let height = max(1, state.maxTotalThreadsPerThreadgroup / width)
            encoder.dispatchThreads(MTLSize(width: destination.width, height: destination.height, depth: 1),
                                    threadsPerThreadgroup: MTLSize(width: width, height: height, depth: 1))
        }
        encoder.endEncoding()
        return true
    }

    private func texture(_ buffer: CVPixelBuffer, plane: Int,
                         format: MTLPixelFormat? = nil) -> (texture: MTLTexture, wrapper: CVMetalTexture)? {
        var wrapper: CVMetalTexture?
        let status = CVMetalTextureCacheCreateTextureFromImage(
            kCFAllocatorDefault, textureCache, buffer, nil, format ?? (plane == 0 ? .r8Unorm : .rg8Unorm),
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
