import CoreVideo
import Foundation
import VideoToolbox

/// Per-viewer bandwidth estimation and bitrate control, in the spirit of WebRTC's delay-based
/// controller: queueing delay (ack latency above the path's baseline) is the congestion signal, and
/// on overuse the bitrate drops to what the viewer is actually receiving, so it lands on the link's
/// capacity within a round trip or two instead of stepping down blindly. Frame rate is preserved;
/// quality is what gives.
final class CongestionController {
    let minBitrate: Int
    let maxBitrate: Int
    private(set) var bitrate: Int
    /// Lowest recent send→ack latency: this viewer's uncongested path plus decode time.
    private(set) var baselineMs = Double.infinity
    /// Smoothed queueing delay above the baseline.
    private(set) var queueMs = 0.0

    private var acked: [(ms: Double, bytes: Int)] = []
    private var sent: [(ms: Double, bytes: Int)] = []
    private var ackCount = 0
    private var lastDecreaseMs = -Double.infinity
    private var lastIncreaseMs = -Double.infinity
    private var checkedLocal = false

    init(start: Int, min: Int, max: Int) {
        self.bitrate = start
        self.minBitrate = min
        self.maxBitrate = max
    }

    var baselineOrZero: Double { baselineMs.isFinite ? baselineMs : 0 }

    func onSent(bytes: Int, now: Double) {
        sent.append((now, bytes))
    }

    func onAck(latencyMs: Double, bytes: Int, now: Double) {
        ackCount += 1
        // Creep upward slowly so the baseline follows a path that genuinely got slower.
        baselineMs = min(latencyMs, baselineMs + 0.02)
        queueMs = queueMs * 0.7 + max(0, latencyMs - baselineMs) * 0.3
        acked.append((now, bytes))
    }

    /// Bits per second over the trailing window.
    func rate(delivered: Bool, now: Double, windowMs: Double = 500) -> Double {
        let samples = delivered ? acked : sent
        let bytes = samples.reduce(0) { $1.ms > now - windowMs ? $0 + $1.bytes : $0 }
        return Double(bytes) * 8 * 1000 / windowMs
    }

    /// Called about every 100 ms; returns the new bitrate when it changes.
    func update(now: Double) -> Int? {
        acked.removeAll { $0.ms < now - 1000 }
        sent.removeAll { $0.ms < now - 1000 }
        guard ackCount >= 3 else { return nil }

        if !checkedLocal {
            // A local or same-LAN viewer has bandwidth to spare: skip the ramp.
            checkedLocal = true
            if baselineMs < 10 && bitrate < maxBitrate {
                bitrate = maxBitrate
                return bitrate
            }
        }
        var next = bitrate
        let delivered = rate(delivered: true, now: now)
        let sending = rate(delivered: false, now: now)
        // A near-idle stream (e.g. constant-frame-rate repeats of a still screen) can't be what's
        // filling a queue, so delay then is path jitter, not congestion; and its tiny delivery rate
        // says nothing about capacity. Only react while actually sending near the target. Longer
        // paths jitter more, so the threshold scales with the baseline.
        let appLimited = sending < 0.3 * Double(bitrate)
        let overuseMs = max(30, baselineMs * 0.4)
        if queueMs > overuseMs, !appLimited, now - lastDecreaseMs > max(150, baselineMs * 1.5) {
            // Overuse: drop to what's getting through, with headroom to drain the queue; at least 15% down.
            let target = delivered > 0 ? delivered * 0.85 : Double(bitrate) * 0.7
            next = Int(min(target, Double(bitrate) * 0.85))
            lastDecreaseMs = now
        } else if queueMs < 8, now - lastDecreaseMs > 1500, now - lastIncreaseMs > 200,
                  sending > 0.5 * Double(bitrate) || baselineMs < 10 {
            // Underuse: probe upward, but only while the link is actually being exercised (or is
            // local), so an idle stretch doesn't leave the bitrate far above proven capacity.
            next = Int(Double(bitrate) * 1.08)
            lastIncreaseMs = now
        }
        next = max(minBitrate, min(maxBitrate, next))
        guard next != bitrate else { return nil }
        bitrate = next
        return next
    }

    /// A severe backlog forced a resync: halve toward what was getting through.
    func severe(now: Double) {
        let delivered = rate(delivered: true, now: now, windowMs: 1000)
        bitrate = max(minBitrate, Int(min(delivered > 0 ? delivered * 0.5 : .infinity, Double(bitrate) * 0.5)))
        lastDecreaseMs = now
        queueMs = 0
    }
}

/// One viewer's stream. Each viewer gets its own encoder and congestion controller (as each Stadia
/// session had), so a slow link gets a lower bitrate at full frame rate without degrading anyone
/// else, and keyframes for one viewer never cost the others. All state lives on the server queue.
///
/// Frame rate is held at the expense of resolution: when the bitrate is too low for the current
/// resolution (too few bits per pixel per frame, where the low-latency encoder starts dropping
/// frames), the viewer steps down a resolution tier, and back up once there's headroom. The client
/// keeps its display size and scales, so a slow link looks softer but still moves at full rate.
final class Viewer {
    let id: Int
    let client: StreamClient
    private let server: StreamServer
    let congestion: CongestionController

    private let sourceWidth: Int
    private let sourceHeight: Int
    private let fps: Int
    private let measureQuality: Bool

    /// Resolution tiers, as fractions of the source; the viewer encodes at `tiers[tier]`.
    private static let tiers = [1.0, 0.75, 0.5, 0.375]
    /// Bits per pixel per frame below which the encoder can't keep up at full frame rate (step down),
    /// and the level a higher tier must offer before stepping back up.
    private static let minBitsPerPixel = 0.035
    private static let upBitsPerPixel = 0.05
    private var tier = 0
    private var lastTierChangeMs = -Double.infinity
    private var encoder: H264Encoder
    /// Scales captured frames to the current tier (nil at full resolution).
    private var scaler: (session: VTPixelTransferSession, pool: CVPixelBufferPool)?
    /// Bumped on every encoder switch; late frames from a replaced encoder are discarded, since
    /// the client's decoder is configured for the new one.
    private var generation = 0
    private var nextSeq: UInt32 = 0

    private(set) var paused = false
    private var needsKeyframe = true
    /// Severe backlog: stop encoding until it drains, then resync with a keyframe.
    private var draining = false
    private var unacked: [(seq: UInt32, sentMs: Double, bytes: Int)] = []
    private(set) var resyncs = 0
    /// Encode calls can block while the hardware encoder is busy, so each viewer submits on its own
    /// queue: one slow encoder must not stall the others or the network queue.
    private let encodeQueue: DispatchQueue
    /// Frames submitted to the encoder and not yet finished. Past `maxInFlight`, the encoder is behind:
    /// skip the captured frame (the encoder simply never sees it) instead of queueing latency.
    private var encodesInFlight = 0
    private let maxEncodesInFlight = 2
    private(set) var skippedFrames = 0

    /// Backlog beyond baseline that gives up on the queue and resyncs.
    private let severeMs = 400.0
    /// A viewer this far behind is stalled (e.g. throttled without pausing): drop its backlog.
    private let stallMs = 2000.0

    init(id: Int, client: StreamClient, server: StreamServer, width: Int, height: Int, fps: Int,
         maxBitrate: Int, measureQuality: Bool) throws {
        self.id = id
        self.client = client
        self.server = server
        self.sourceWidth = width
        self.sourceHeight = height
        self.fps = fps
        self.measureQuality = measureQuality
        encodeQueue = DispatchQueue(label: "simstream.encode.\(id)", qos: .userInteractive)
        congestion = CongestionController(start: min(maxBitrate, 8_000_000),
                                          min: min(maxBitrate, 1_000_000), max: maxBitrate)
        encoder = try H264Encoder(width: width, height: height, fps: fps, bitrate: congestion.bitrate)
        attach(encoder)
    }

    var resolution: (width: Int, height: Int) { (encoder.width, encoder.height) }

    private func size(ofTier tier: Int) -> (width: Int, height: Int) {
        let scale = Self.tiers[tier]
        return (max(2, Int(Double(sourceWidth) * scale) & ~1), max(2, Int(Double(sourceHeight) * scale) & ~1))
    }

    private func bitsPerPixel(atTier tier: Int) -> Double {
        let (w, h) = size(ofTier: tier)
        return Double(congestion.bitrate) / (Double(w * h) * Double(fps))
    }

    private func attach(_ encoder: H264Encoder) {
        if measureQuality { encoder.quality = QualityProbe() }
        let generation = self.generation
        encoder.onFrame = { [weak self, queue = server.queue] frame in
            queue.async {
                guard let self, self.generation == generation else { return }
                self.send(frame)
            }
        }
    }

    /// Picks the resolution tier for the current bitrate; switches encoders when it changes.
    private func updateTier(now: Double) {
        var target = tier
        while target < Self.tiers.count - 1 && bitsPerPixel(atTier: target) < Self.minBitsPerPixel { target += 1 }
        if target == tier {
            while target > 0 && bitsPerPixel(atTier: target - 1) >= Self.upBitsPerPixel { target -= 1 }
        }
        // Step down promptly (frames are being lost); step up slowly (avoid flapping).
        guard target != tier, now - lastTierChangeMs > (target > tier ? 500 : 3000) else { return }
        let (w, h) = size(ofTier: target)
        do {
            let replacement = try H264Encoder(width: w, height: h, fps: fps, bitrate: congestion.bitrate)
            var newScaler: (VTPixelTransferSession, CVPixelBufferPool)?
            if target > 0 { newScaler = try makeScaler(width: w, height: h) }
            generation += 1
            attach(replacement)
            encoder = replacement
            scaler = newScaler
            tier = target
            lastTierChangeMs = now
            needsKeyframe = true
            log(String(format: "viewer %d: %@ to %d×%d at %.1f Mbps", id, target > 0 && w < sourceWidth ? "scaling" : "restoring",
                       w, h, Double(congestion.bitrate) / 1e6))
        } catch {
            log("viewer \(id): could not switch resolution: \(error)")
        }
    }

    private func makeScaler(width: Int, height: Int) throws -> (VTPixelTransferSession, CVPixelBufferPool) {
        var session: VTPixelTransferSession?
        guard VTPixelTransferSessionCreate(allocator: nil, pixelTransferSessionOut: &session) == noErr, let session else {
            throw SimStreamError("VTPixelTransferSessionCreate failed")
        }
        VTSessionSetProperty(session, key: kVTPixelTransferPropertyKey_RealTime, value: kCFBooleanTrue)
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
        return (session, pool)
    }

    /// A captured frame. Encoded for this viewer unless it's paused or draining a backlog.
    func offer(_ pixelBuffer: CVPixelBuffer, captureMs: Double, inputSeq: UInt32) {
        guard !paused else { return }
        let now = Clock.ms()
        let backlog = unacked.first.map { now - $0.sentMs - congestion.baselineOrZero } ?? 0

        if draining {
            guard backlog < 100 || backlog > stallMs else { return }
            if backlog > stallMs { unacked.removeAll() }
            draining = false
            needsKeyframe = true
        } else if backlog > severeMs {
            draining = true
            resyncs += 1
            congestion.severe(now: now)
            encoder.setBitrate(congestion.bitrate)
            log(String(format: "viewer %d: %.0f ms backlog, resyncing at %.1f Mbps", id, backlog,
                       Double(congestion.bitrate) / 1e6))
            updateTier(now: now)
            return
        }

        guard encodesInFlight < maxEncodesInFlight else {
            skippedFrames += 1
            return
        }
        encodesInFlight += 1
        let force = needsKeyframe
        needsKeyframe = false
        encodeQueue.async { [weak self, encoder, scaler, queue = server.queue] in
            var input = pixelBuffer
            if let scaler {
                var scaled: CVPixelBuffer?
                if CVPixelBufferPoolCreatePixelBuffer(nil, scaler.pool, &scaled) == kCVReturnSuccess, let scaled,
                   VTPixelTransferSessionTransferImage(scaler.session, from: pixelBuffer, to: scaled) == noErr {
                    input = scaled
                }
            }
            encoder.encode(input, captureMs: captureMs, forceKeyframe: force, inputSeq: inputSeq) {
                queue.async { self?.encodesInFlight -= 1 }
            }
        }
    }

    /// Returns and resets the count of captured frames skipped because the encoder was behind.
    func takeSkipped() -> Int {
        defer { skippedFrames = 0 }
        return skippedFrames
    }

    private func send(_ frame: EncodedFrame) {
        guard !paused else { return }
        let now = Clock.ms()
        // Sequence numbers are per viewer, continuous across encoder switches, so acks line up.
        nextSeq &+= 1
        var frame = frame
        frame.seq = nextSeq
        frame.displaySize = (sourceWidth, sourceHeight)
        server.sendFrame(frame, to: client)
        unacked.append((frame.seq, now, frame.data.count))
        congestion.onSent(bytes: frame.data.count, now: now)
    }

    func ack(_ seq: UInt32) {
        let now = Clock.ms()
        if let frame = unacked.first(where: { $0.seq == seq }) {
            congestion.onAck(latencyMs: now - frame.sentMs, bytes: frame.bytes, now: now)
        }
        unacked.removeAll { $0.seq <= seq }
    }

    /// Periodic bitrate and resolution control.
    func tick() {
        let now = Clock.ms()
        if let bitrate = congestion.update(now: now) {
            encoder.setBitrate(bitrate)
        }
        updateTier(now: now)
    }

    func requestKeyframe() {
        needsKeyframe = true
    }

    func pause() {
        paused = true
        unacked.removeAll()
    }

    func resume() {
        paused = false
        draining = false
        unacked.removeAll()
        needsKeyframe = true
    }

    func takeStats() -> H264Encoder.Stats {
        encoder.takeStats()
    }
}
