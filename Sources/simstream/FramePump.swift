import CoreVideo
import Foundation
import IOSurface
import SimBridge
import VideoToolbox

/// Pulls frames out of the simulator's framebuffer and feeds the encoder.
///
/// Capture is render-locked: the guest's per-frame damage callback triggers a capture as soon as a
/// frame lands, so the stream inherits the simulator's own cadence (no beating between a polling
/// timer and the render clock). A display-rate tick only fills in: keyframe requests, repeated
/// frames for constant frame rate, refinement after motion, and a fallback if callbacks go quiet.
///
/// With `constantFrameRate`, the last frame is re-encoded on every tick while nothing changes
/// (Stadia-style CFR). Repeats cost a few hundred bytes, keep the client's presentation cadence
/// steady, and let the encoder keep sharpening a still image. Without it, `refineFrames` extra
/// frames sharpen the settled image and then a static screen costs nothing.
/// Nothing is encoded while no one is watching.
final class FramePump {
    let width: Int
    let height: Int

    private let sim: SBSimulator
    private let encoder: H264Encoder
    private let queue = DispatchQueue(label: "simstream.capture", qos: .userInteractive)
    private let frameInterval: Double
    private let transfer: VTPixelTransferSession
    private let pool: CVPixelBufferPool
    private var timer: DispatchSourceTimer?

    private var source: (surface: IOSurfaceRef, buffer: CVPixelBuffer)?
    private var lastSeed: UInt32 = 0
    private var lastCaptureMs: Double = 0
    private var keyframeRequested = true
    private var pendingInputSeq: UInt32 = 0
    private let refineFrames: Int
    private var refineRemaining = 0
    private let constantFrameRate: Bool
    private var lastDamageMs = -Double.infinity
    private var watching = false

    private(set) var capturedFrames = 0
    /// Source-cadence health, from IOSurface seed deltas between consecutive captures (the guest bumps
    /// the seed once per rendered frame): a delta over 1 means rendered frames were never captured.
    struct Cadence { var damage = 0, captured = 0, missed = 0 }
    private var cadence = Cadence()
    func takeCadence() -> Cadence { queue.sync { defer { cadence = Cadence() }; return cadence } }

    init(sim: SBSimulator, encoder: H264Encoder, fps: Int, refineFrames: Int, constantFrameRate: Bool) throws {
        self.sim = sim
        self.refineFrames = refineFrames
        self.constantFrameRate = constantFrameRate
        self.encoder = encoder
        self.width = encoder.width
        self.height = encoder.height
        self.frameInterval = 1000.0 / Double(fps)

        var transfer: VTPixelTransferSession?
        guard VTPixelTransferSessionCreate(allocator: nil, pixelTransferSessionOut: &transfer) == noErr, let transfer else {
            throw SimStreamError("VTPixelTransferSessionCreate failed")
        }
        VTSessionSetProperty(transfer, key: kVTPixelTransferPropertyKey_RealTime, value: kCFBooleanTrue)
        VTSessionSetProperty(transfer, key: kVTPixelTransferPropertyKey_DestinationYCbCrMatrix,
                             value: kCVImageBufferYCbCrMatrix_ITU_R_709_2)
        self.transfer = transfer

        let attrs: [CFString: Any] = [
            kCVPixelBufferPixelFormatTypeKey: kCVPixelFormatType_420YpCbCr8BiPlanarVideoRange,
            kCVPixelBufferWidthKey: encoder.width,
            kCVPixelBufferHeightKey: encoder.height,
            kCVPixelBufferIOSurfacePropertiesKey: [:] as CFDictionary,
        ]
        var pool: CVPixelBufferPool?
        guard CVPixelBufferPoolCreate(nil, nil, attrs as CFDictionary, &pool) == kCVReturnSuccess, let pool else {
            throw SimStreamError("CVPixelBufferPoolCreate failed")
        }
        self.pool = pool
    }

    func start() {
        sim.setFrameHandler({ [weak self] in self?.capture(fromDamage: true) }, queue: queue)
        let timer = DispatchSource.makeTimerSource(flags: .strict, queue: queue)
        timer.schedule(deadline: .now(), repeating: .nanoseconds(Int(frameInterval * 1_000_000)), leeway: .microseconds(500))
        timer.setEventHandler { [weak self] in self?.capture(fromDamage: false) }
        timer.resume()
        self.timer = timer
    }

    /// Whether any viewer is currently watching; with none, nothing is captured or encoded.
    func setWatching(_ watching: Bool) {
        queue.async {
            if watching && !self.watching { self.keyframeRequested = true }
            self.watching = watching
        }
    }

    func requestKeyframe() {
        queue.async { self.keyframeRequested = true }
    }

    /// Records that an input event was injected, so the next changed frame can be tagged with it
    /// and the client can measure input-to-photon latency.
    func noteInput(_ seq: UInt32) {
        queue.async { self.pendingInputSeq = seq }
    }

    private func capture(fromDamage: Bool) {
        let now = Clock.ms()
        if fromDamage {
            lastDamageMs = now
            cadence.damage += 1
        }
        guard watching else { return }
        // Damage frames only need guarding against sources faster than the cap (e.g. 120 Hz);
        // the tick must not crowd them.
        if now - lastCaptureMs < frameInterval * (fromDamage ? 0.6 : 0.9) { return }
        guard let surface = sim.framebuffer() else { return }

        let seed = IOSurfaceGetSeed(surface)
        let surfaceChanged = source?.surface !== surface
        let contentChanged = surfaceChanged || seed != lastSeed
        if !fromDamage && contentChanged && now - lastDamageMs < 100 && now - lastCaptureMs < frameInterval * 1.5 {
            return  // a render is in flight; its damage callback will capture it in step
        }
        let repeating = !fromDamage && !contentChanged && (constantFrameRate || refineRemaining > 0)
        guard contentChanged || keyframeRequested || repeating else { return }
        refineRemaining = contentChanged ? refineFrames : max(0, refineRemaining - 1)

        if surfaceChanged {
            var buffer: Unmanaged<CVPixelBuffer>?
            guard CVPixelBufferCreateWithIOSurface(nil, surface, nil, &buffer) == kCVReturnSuccess,
                  let buffer = buffer?.takeRetainedValue() else { return }
            source = (surface, buffer)
        }

        var output: CVPixelBuffer?
        guard CVPixelBufferPoolCreatePixelBuffer(nil, pool, &output) == kCVReturnSuccess, let output,
              let source,
              VTPixelTransferSessionTransferImage(transfer, from: source.buffer, to: output) == noErr else { return }

        if contentChanged && !surfaceChanged && lastSeed != 0 {
            cadence.missed += Int(max(0, Int64(seed) - Int64(lastSeed) - 1))
        }
        cadence.captured += contentChanged ? 1 : 0
        lastSeed = seed
        lastCaptureMs = now
        capturedFrames += 1

        let force = keyframeRequested
        keyframeRequested = false
        var inputSeq: UInt32 = 0
        if contentChanged {
            inputSeq = pendingInputSeq
            pendingInputSeq = 0
        }
        encoder.encode(output, captureMs: now, forceKeyframe: force, inputSeq: inputSeq)
    }
}
