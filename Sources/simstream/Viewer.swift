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
    let startBitrate: Int
    private(set) var bitrate: Int
    /// Lowest recent send→ack latency: this viewer's uncongested path plus decode time.
    private(set) var baselineMs = Double.infinity
    /// Smoothed queueing delay above the baseline.
    private(set) var queueMs = 0.0

    private var acked: [(ms: Double, bytes: Int)] = []
    private var sent: [(ms: Double, bytes: Int)] = []
    private var ackCount = 0
    private var lastAckMs = -Double.infinity
    private var lastDecreaseMs = -Double.infinity
    private var lastIncreaseMs = -Double.infinity
    private var checkedLocal = false

    init(start: Int, min: Int, max: Int) {
        self.bitrate = start
        self.startBitrate = start
        self.minBitrate = min
        self.maxBitrate = max
    }

    var baselineOrZero: Double { baselineMs.isFinite ? baselineMs : 0 }

    func onSent(bytes: Int, now: Double) {
        sent.append((now, bytes))
    }

    func onAck(latencyMs: Double, bytes: Int, now: Double) {
        ackCount += 1
        lastAckMs = now
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
        // Acks have paused: a transport stall (e.g. a TCP retransmit on a lossy wireless hop). The
        // delivery rate reads near zero during one and says nothing about capacity, so hold.
        guard now - lastAckMs < 150 else { return nil }

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
        } else if queueMs < max(8, baselineMs * 0.15), now - lastDecreaseMs > 1500, now - lastIncreaseMs > 200,
                  sending > 0.5 * Double(bitrate) || baselineMs < 10 || bitrate < startBitrate {
            // Underuse: probe upward, but only while the link is actually being exercised (or is
            // local), so an idle stretch doesn't leave the bitrate far above proven capacity. Below the
            // starting bitrate it may climb even when idle, so a past congestion episode doesn't pin a
            // viewer at the floor. Longer paths jitter more, so "no queue" scales with the baseline.
            next = Int(Double(bitrate) * 1.08)
            lastIncreaseMs = now
        }
        next = max(minBitrate, min(maxBitrate, next))
        guard next != bitrate else { return nil }
        bitrate = next
        return next
    }

    /// A severe backlog: halve toward what was getting through, but only if we were actually
    /// pushing the link. A backlog while sending well under the target is a stall, not congestion
    /// we caused, and cutting the bitrate would only degrade the picture once it clears.
    func severe(now: Double) {
        guard rate(delivered: false, now: now, windowMs: 1000) >= 0.5 * Double(bitrate) else { return }
        let delivered = rate(delivered: true, now: now, windowMs: 1000)
        bitrate = max(minBitrate, Int(min(delivered > 0 ? delivered * 0.5 : .infinity, Double(bitrate) * 0.5)))
        lastDecreaseMs = now
        queueMs = 0
    }
}

/// How a viewer's stream handles heavy full-screen motion (swiping home, the app switcher) when its
/// link can't carry full-resolution 60 fps at full quality. Chosen per viewer from the page.
enum TransitionMode: String {
    /// Keep the bitrate within the link: briefly soft frames, lowest latency.
    case soft
    /// Let the encoder spend up to 2.5x the link rate and cap its quantizer, so big frames stay
    /// sharp at the cost of a short queue (extra latency) during the transition. Sustained heavy
    /// motion still converges back to the link rate through the congestion controller.
    case burst
    /// During heavy motion, encode every other frame (30 fps) so each gets twice the bits; back to
    /// 60 as soon as frames are light again.
    case fps30
}

/// One viewer's stream. Each viewer gets its own encoder and congestion controller (as each Stadia
/// session had), so a slow link gets a lower bitrate at full frame rate without degrading anyone
/// else, and keyframes for one viewer never cost the others. All state lives on the server queue.
///
/// Full resolution unless it demonstrably costs frames: when the low-latency encoder drops more than
/// 10% of frames (its bitrate can't fit them), the viewer steps down a resolution tier, and tries
/// the next tier up after a quiet spell (3 s, doubling up to 30 s if the attempt drops frames
/// again). The client keeps its display size and scales, so a thin link looks softer but still
/// moves at full rate.
final class Viewer {
    let id: Int
    let client: StreamClient
    private let server: StreamServer
    let congestion: CongestionController

    private let sourceWidth: Int
    private let sourceHeight: Int
    private let fps: Int
    private let measureQuality: Bool
    /// Off by default: stepping resolution down didn't read as an improvement, so viewers stay at
    /// full resolution and a thin link costs frames instead. `--adaptive-res` turns it back on.
    private let adaptiveResolution: Bool

    /// Resolution tiers, as fractions of the source; the viewer encodes at `tiers[tier]`.
    private static let tiers = [1.0, 0.75, 0.5, 0.375]
    private var tier = 0
    private var lastTierChangeMs = -Double.infinity
    private var lastStepUpMs = -Double.infinity
    private var lastDropMs = -Double.infinity
    private var stepUpAfterMs = 3000.0
    /// Encoder totals sampled every tick over the last second, to compute the drop rate.
    private var dropWindow: [(ms: Double, encoded: Int, dropped: Int)] = []
    private var encoder: VideoEncoder
    private var codec: VideoCodec = .h264
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
    private var lastAckMs = -Double.infinity
    private var lastResyncMs = -Double.infinity
    /// Resynced twice without a single ack in between: the page isn't decoding (e.g. a stale tab
    /// running an older client). Stop spending encoder time on it until it acks something.
    private var unresponsive = false
    private var lastProbeMs = -Double.infinity
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

    private(set) var transitionMode = TransitionMode.soft
    private var bitrateFactor: Double {
        switch transitionMode {
        case .soft: 1
        case .burst: 2.5
        // Half the frames at the same bits per second: give the encoder twice the rate, since its
        // per-frame budget follows the expected (60 fps) frame rate.
        case .fps30: heavy ? 2 : 1
        }
    }
    /// The bitrate the encoder is actually given: the link's target, times the burst allowance.
    private var encoderBitrate: Int { Int(Double(congestion.bitrate) * bitrateFactor) }
    /// fps30 mode: recent frame sizes, whether we're in a heavy stretch, and a frame counter.
    private var recentSizes: [Int] = []
    private var heavy = false
    private var heavyCounter = 0
    private(set) var halvedFrames = 0
    /// A viewer this far behind is stalled (e.g. throttled without pausing): drop its backlog.
    private let stallMs = 2000.0

    init(id: Int, client: StreamClient, server: StreamServer, width: Int, height: Int, fps: Int,
         maxBitrate: Int, measureQuality: Bool, adaptiveResolution: Bool) throws {
        self.adaptiveResolution = adaptiveResolution
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
        encoder = try VideoEncoder(codec: .h264, width: width, height: height, fps: fps, bitrate: congestion.bitrate)
        attach(encoder)
    }

    var resolution: (width: Int, height: Int) { (encoder.width, encoder.height) }

    private func size(ofTier tier: Int) -> (width: Int, height: Int) {
        let scale = Self.tiers[tier]
        return (max(2, Int(Double(sourceWidth) * scale) & ~1), max(2, Int(Double(sourceHeight) * scale) & ~1))
    }

    private func attach(_ encoder: VideoEncoder) {
        encoder.setMaxQP(transitionMode == .burst ? 24 : nil)
        if measureQuality { encoder.quality = QualityProbe() }
        let generation = self.generation
        encoder.onFrame = { [weak self, queue = server.queue] frame in
            queue.async {
                guard let self, self.generation == generation else { return }
                self.send(frame)
            }
        }
    }

    /// Steps the resolution tier on measured encoder drops; switches encoders when it changes.
    private func updateTier(now: Double) {
        guard adaptiveResolution else { return }
        let totals = encoder.frameTotals()
        dropWindow.append((now, totals.encoded, totals.dropped))
        dropWindow.removeAll { $0.ms < now - 1000 }
        guard let first = dropWindow.first else { return }
        let encoded = totals.encoded - first.encoded, dropped = totals.dropped - first.dropped
        if dropped > 0 { lastDropMs = now }

        var target = tier
        if encoded + dropped >= 20, Double(dropped) > 0.1 * Double(encoded + dropped),
           tier < Self.tiers.count - 1, now - lastTierChangeMs > 500 {
            target = tier + 1
            // The last step up didn't hold: wait longer before trying again.
            if now - lastStepUpMs < 5000 { stepUpAfterMs = min(stepUpAfterMs * 2, 30000) }
        } else if tier > 0, now - lastDropMs > stepUpAfterMs, now - lastTierChangeMs > stepUpAfterMs {
            target = tier - 1
            lastStepUpMs = now
        }
        guard target != tier else { return }
        let oldTier = tier
        let (w, h) = size(ofTier: target)
        do {
            let replacement = try VideoEncoder(codec: codec, width: w, height: h, fps: fps, bitrate: encoderBitrate)
            var newScaler: (VTPixelTransferSession, CVPixelBufferPool)?
            if target > 0 { newScaler = try makeScaler(width: w, height: h) }
            generation += 1
            attach(replacement)
            encoder = replacement
            scaler = newScaler
            tier = target
            lastTierChangeMs = now
            dropWindow.removeAll()
            needsKeyframe = true
            log(String(format: "viewer %d: %@ to %d×%d at %.1f Mbps (%@)", id, w < sourceWidth ? "scaling" : "restoring",
                       w, h, Double(congestion.bitrate) / 1e6, target > oldTier ? "encoder dropping frames" : "no drops lately"))
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
    func offer(_ pixelBuffer: CVPixelBuffer, captureMs: Double, input: InputTag) {
        guard !paused else { return }
        if unresponsive {
            // Probe with a keyframe every 10 s: a working page decodes it and acks (which
            // clears the flag); a stale one ignores it at the cost of one frame per probe.
            let now = Clock.ms()
            guard now - lastProbeMs > 10_000 else { return }
            lastProbeMs = now
            unacked.removeAll()
            needsKeyframe = true
        }
        let now = Clock.ms()
        let backlog = unresponsive ? 0 : (unacked.first.map { now - $0.sentMs - congestion.baselineOrZero } ?? 0)

        if draining {
            // Nothing was encoded while draining, so the encoder's reference chain is intact and the
            // client has (or will get, TCP being reliable) every frame it references: continue with
            // ordinary frames rather than a keyframe that would land on a link just recovering.
            guard backlog < 100 || backlog > stallMs else { return }
            if backlog > stallMs { unacked.removeAll() }
            draining = false
        } else if backlog > (transitionMode == .burst ? severeMs * 1.5 : severeMs) {
            if resyncs >= 2 && lastAckMs < lastResyncMs {
                unresponsive = true
                unacked.removeAll()
                log("viewer \(id): no acks across 2 resyncs, not encoding for it until it responds (stale page?)")
                return
            }
            draining = true
            resyncs += 1
            lastResyncMs = now
            congestion.severe(now: now)
            encoder.setBitrate(encoderBitrate)
            log(String(format: "viewer %d: %.0f ms backlog, pausing encode until it drains (%.1f Mbps)", id, backlog,
                       Double(congestion.bitrate) / 1e6))
            updateTier(now: now)
            return
        }

        if transitionMode == .fps30 && heavy {
            heavyCounter += 1
            if heavyCounter % 2 == 1 {
                halvedFrames += 1
                return
            }
        }
        guard encodesInFlight < maxEncodesInFlight else {
            skippedFrames += 1
            return
        }
        encodesInFlight += 1
        let force = needsKeyframe
        needsKeyframe = false
        encodeQueue.async { [weak self, encoder, scaler, queue = server.queue] in
            var scaledInput = pixelBuffer
            if let scaler {
                var scaled: CVPixelBuffer?
                if CVPixelBufferPoolCreatePixelBuffer(nil, scaler.pool, &scaled) == kCVReturnSuccess, let scaled,
                   VTPixelTransferSessionTransferImage(scaler.session, from: pixelBuffer, to: scaled) == noErr {
                    scaledInput = scaled
                }
            }
            encoder.encode(scaledInput, captureMs: captureMs, forceKeyframe: force, input: input) {
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
        if transitionMode == .fps30 { trackHeaviness(frame.data.count) }
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
        lastAckMs = now
        if unresponsive {
            unresponsive = false
            needsKeyframe = true
            log("viewer \(id): responding again")
        }
        if let frame = unacked.first(where: { $0.seq == seq }) {
            congestion.onAck(latencyMs: now - frame.sentMs, bytes: frame.bytes, now: now)
        }
        unacked.removeAll { $0.seq <= seq }
    }

    /// Periodic bitrate and resolution control.
    func tick() {
        let now = Clock.ms()
        if congestion.update(now: now) != nil {
            encoder.setBitrate(encoderBitrate)
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

    var codecName: String { encoder.codec.rawValue }

    func setTransitionMode(_ mode: TransitionMode) {
        guard mode != transitionMode else { return }
        transitionMode = mode
        heavy = false
        recentSizes.removeAll()
        encoder.setBitrate(encoderBitrate)
        encoder.setMaxQP(mode == .burst ? 24 : nil)
        log("viewer \(id): transitions \(mode.rawValue)")
    }

    /// fps30 mode: heavy while frames run well over their 60 fps share of the bitrate; light again
    /// once several in a row are small (a settled screen's frames are tiny).
    private func trackHeaviness(_ bytes: Int) {
        recentSizes.append(bytes)
        if recentSizes.count > 6 { recentSizes.removeFirst() }
        let budget = Double(congestion.bitrate) / Double(fps) / 8
        if !heavy, recentSizes.suffix(2).count == 2, recentSizes.suffix(2).allSatisfy({ Double($0) > 1.5 * budget }) {
            heavy = true
            heavyCounter = 0
            // Same bits per second over half the frames: twice the bits per frame.
            encoder.setBitrate(encoderBitrate)
        } else if heavy, recentSizes.count == 6, recentSizes.allSatisfy({ Double($0) < 0.6 * budget }) {
            heavy = false
            encoder.setBitrate(encoderBitrate)
        }
    }

    func takeHalved() -> Int {
        defer { halvedFrames = 0 }
        return halvedFrames
    }

    /// Switches this viewer to another codec (after the client says it can decode it).
    func use(_ newCodec: VideoCodec) {
        guard newCodec != codec else { return }
        do {
            let replacement = try VideoEncoder(codec: newCodec, width: encoder.width, height: encoder.height,
                                               fps: fps, bitrate: encoderBitrate)
            generation += 1
            attach(replacement)
            encoder = replacement
            codec = newCodec
            dropWindow.removeAll()
            needsKeyframe = true
            log("viewer \(id): using \(newCodec.rawValue)")
        } catch {
            log("viewer \(id): \(newCodec.rawValue) unavailable (\(error)), staying on \(codec.rawValue)")
        }
    }

    func takeStats() -> VideoEncoder.Stats {
        encoder.takeStats()
    }
}
