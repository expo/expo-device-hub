import CoreVideo
import Foundation

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
final class Viewer {
    let id: Int
    let client: StreamClient
    private let server: StreamServer
    private let encoder: H264Encoder
    let congestion: CongestionController

    private(set) var paused = false
    private var needsKeyframe = true
    /// Severe backlog: stop encoding until it drains, then resync with a keyframe.
    private var draining = false
    private var unacked: [(seq: UInt32, sentMs: Double, bytes: Int)] = []
    private(set) var resyncs = 0

    /// Backlog beyond baseline that gives up on the queue and resyncs.
    private let severeMs = 400.0
    /// A viewer this far behind is stalled (e.g. throttled without pausing): drop its backlog.
    private let stallMs = 2000.0

    init(id: Int, client: StreamClient, server: StreamServer, width: Int, height: Int, fps: Int,
         maxBitrate: Int, measureQuality: Bool) throws {
        self.id = id
        self.client = client
        self.server = server
        congestion = CongestionController(start: min(maxBitrate, 8_000_000),
                                          min: min(maxBitrate, 1_000_000), max: maxBitrate)
        encoder = try H264Encoder(width: width, height: height, fps: fps, bitrate: congestion.bitrate)
        if measureQuality { encoder.quality = QualityProbe() }
        encoder.onFrame = { [weak self, queue = server.queue] frame in
            queue.async { self?.send(frame) }
        }
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
            return
        }

        let force = needsKeyframe
        needsKeyframe = false
        encoder.encode(pixelBuffer, captureMs: captureMs, forceKeyframe: force, inputSeq: inputSeq)
    }

    private func send(_ frame: EncodedFrame) {
        guard !paused else { return }
        let now = Clock.ms()
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

    /// Periodic bitrate control.
    func tick() {
        if let bitrate = congestion.update(now: Clock.ms()) {
            encoder.setBitrate(bitrate)
        }
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
