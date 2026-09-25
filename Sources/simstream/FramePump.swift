import CoreVideo
import Foundation
import IOSurface
import SimBridge
import VideoToolbox

/// Pulls frames out of the simulator's framebuffer and hands them to `onFrame` (each viewer encodes
/// its own copy).
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

    /// Called on the capture queue with each frame to stream.
    var onFrame: ((CVPixelBuffer, _ captureMs: Double, _ input: InputTag) -> Void)?

    private let sim: SBSimulator
    private let queue = DispatchQueue(label: "simstream.capture", qos: .userInteractive)
    private let frameInterval: Double
    private let transfer: VTPixelTransferSession
    private let pool: CVPixelBufferPool
    private var timer: DispatchSourceTimer?

    private var source: (surface: IOSurfaceRef, buffer: CVPixelBuffer)?
    private var lastSeed: UInt32 = 0
    private var lastCaptureMs: Double = 0
    private var frameRequested = true
    private var deferredCapture = false
    private var pendingInput = InputTag()
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

    init(sim: SBSimulator, width: Int, height: Int, fps: Int, refineFrames: Int, constantFrameRate: Bool) throws {
        self.sim = sim
        self.refineFrames = refineFrames
        self.constantFrameRate = constantFrameRate
        self.width = width
        self.height = height
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
            kCVPixelBufferWidthKey: width,
            kCVPixelBufferHeightKey: height,
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
            if watching && !self.watching { self.frameRequested = true }
            self.watching = watching
        }
    }

    /// Capture on the next tick even if nothing changed (e.g. a viewer needs a keyframe).
    func requestFrame() {
        queue.async { self.frameRequested = true }
    }

    /// Records that an input event was injected, so the next changed frame can be tagged with it
    /// and the client can measure input-to-photon latency.
    func noteInput(_ input: InputTag) {
        queue.async { self.pendingInput = input }
    }

    private func capture(fromDamage: Bool) {
        let now = Clock.ms()
        if fromDamage {
            lastDamageMs = now
            cadence.damage += 1
        }
        guard watching else { return }
        if fromDamage {
            // Stay under the frame-rate cap (e.g. with a 120 Hz source) without losing frames: a
            // render that lands too soon after the last capture is deferred, not dropped. Heavy
            // content makes the guest deliver frames in uneven bunches.
            let wait = frameInterval * 0.6 - (now - lastCaptureMs)
            if wait > 0 {
                if !deferredCapture {
                    deferredCapture = true
                    queue.asyncAfter(deadline: .now() + .microseconds(Int(wait * 1000))) { [weak self] in
                        self?.deferredCapture = false
                        self?.capture(fromDamage: true)
                    }
                }
                return
            }
        } else if now - lastCaptureMs < frameInterval * 0.9 {
            return  // the tick must not crowd render-locked captures
        }
        guard let surface = sim.framebuffer() else { return }

        let seed = IOSurfaceGetSeed(surface)
        let surfaceChanged = source?.surface !== surface
        let contentChanged = surfaceChanged || seed != lastSeed
        if !fromDamage && contentChanged && now - lastDamageMs < 100 && now - lastCaptureMs < frameInterval * 1.5 {
            return  // a render is in flight; its damage callback will capture it in step
        }
        // Repeats (CFR / refinement) only fill idle time: while the guest is rendering, its own
        // frames set the cadence, and a repeat squeezed between two would be a duplicate.
        let idle = now - lastDamageMs > frameInterval * 1.5
        let repeating = !fromDamage && !contentChanged && idle && (constantFrameRate || refineRemaining > 0)
        guard contentChanged || frameRequested || repeating else { return }
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

        frameRequested = false
        var input = InputTag()
        if contentChanged {
            input = pendingInput
            pendingInput = InputTag()
        }
        onFrame?(output, now, input)
    }
}
