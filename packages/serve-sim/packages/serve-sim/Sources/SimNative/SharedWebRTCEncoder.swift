import CoreMedia
import CoreVideo
import Foundation
import LiveKitWebRTC
import StreamingPolicy

private typealias EncoderCallback = (LKRTCEncodedImage, any LKRTCCodecSpecificInfo) -> Bool

/// Per-proxy counters, so a peer that never sends video shows which step it is missing.
struct SharedEncoderPeerStats: Codable {
    let peer: Int
    var starts: UInt64 = 0
    var releases: UInt64 = 0
    var callbackSets: UInt64 = 0
    var callbackClears: UInt64 = 0
    var encodeCalls: UInt64 = 0
    var deliveries: UInt64 = 0
    var missingCallback: UInt64 = 0
    var rejectedByCallback: UInt64 = 0
    var live: Bool = false
}

final class SharedWebRTCEncoderFactory: NSObject, LKRTCVideoEncoderFactory {
    private let fallback = LKRTCDefaultVideoEncoderFactory()
    private let shared: SharedWebRTCEncoder
    private let h264Allowed: () -> Bool

    init(bitrate: Int, fps: Int, h264Allowed: @escaping () -> Bool) {
        shared = SharedWebRTCEncoder(bitrate: bitrate, fps: fps)
        self.h264Allowed = h264Allowed
    }

    func createEncoder(_ info: LKRTCVideoCodecInfo) -> (any LKRTCVideoEncoder)? {
        if info.name.caseInsensitiveCompare("H264") == .orderedSame, h264Allowed() {
            let mode: LKRTCH264PacketizationMode = info.parameters["packetization-mode"] == "0"
                ? .singleNalUnit : .nonInterleaved
            return shared.makeProxy(packetizationMode: mode)
        }
        return fallback.createEncoder(info)
    }

    func supportedCodecs() -> [LKRTCVideoCodecInfo] {
        fallback.supportedCodecs()
    }

    func requestIDR() {
        shared.requestIDR()
    }

    func updateFps(_ fps: Int) {
        shared.updateFps(fps)
    }

    func encodedFrameCount() -> UInt64 {
        shared.encodedFrameCount()
    }

    func updateTargetBitrate(_ bitrate: Int) {
        shared.updateTargetBitrate(bitrate)
    }

    /// The observer runs on the shared encoder queue when the resolution step changes.
    func setScaleObserver(_ observer: @escaping (Double) -> Void) {
        shared.setScaleObserver(observer)
    }

    func resolutionStatus() -> (scale: Double, step: Int, changes: UInt64) {
        shared.resolutionStatus()
    }

    func starvedRecoveries() -> UInt64 {
        shared.starvedRecoveries()
    }

    func lowLatencyFallbacks() -> UInt64 {
        shared.lowLatencyFallbacks()
    }

    func peerStats() -> [SharedEncoderPeerStats] {
        shared.peerStats()
    }

    func stop() {
        shared.stop()
    }
}

private final class SharedWebRTCEncoder: @unchecked Sendable {
    private struct Pending {
        var peers: Set<Int>
        let rtpTimestamp: UInt32
        let captureTime: CMTime
        let width: Int32
        let height: Int32
    }

    private struct Completed {
        let timestamp: Int64
        let previousTimestamp: Int64?
        let encoded: H264Encoder.Encoded
        let annexB: Data
        let metadata: Pending
    }

    private struct QueuedFrame {
        let timestamp: Int64
        let buffer: CVPixelBuffer
        let forceIDR: Bool
        let bitrate: Int
    }

    private let queue = DispatchQueue(label: "webrtc-shared-h264", qos: .userInteractive)
    private let queueKey = DispatchSpecificKey<Bool>()
    private let encoder: H264Encoder
    private var policy: SharedH264Policy
    private var callbacks: [Int: (EncoderCallback, LKRTCH264PacketizationMode)] = [:]
    private var packetizationModes: [Int: LKRTCH264PacketizationMode] = [:]
    private var pending: [Int64: Pending] = [:]
    private var completed: [Int64: Completed] = [:]
    private var completedOrder: [Int64] = []
    private var lastEncodedTimestamp: Int64?
    private var lastDeliveredTimestamp: [Int: Int64] = [:]
    private var nextPeer = 0
    private var backlog = SharedFrameBacklog()
    private var queuedFrame: QueuedFrame?
    private var stopped = false
    private var encodedFrames: UInt64 = 0
    private var fallbacks: UInt64 = 0
    private var fps: Int
    private var resolution: SharedResolutionPolicy
    private var scaleObserver: ((Double) -> Void)?
    private var peers: [Int: SharedEncoderPeerStats] = [:]

    private func stat(_ peer: Int, _ update: (inout SharedEncoderPeerStats) -> Void) {
        var value = peers[peer] ?? SharedEncoderPeerStats(peer: peer)
        update(&value)
        peers[peer] = value
    }

    init(bitrate: Int, fps: Int) {
        self.fps = fps
        encoder = H264Encoder(fps: fps, bitrate: bitrate,
                              constrainedBaseline: true, dynamicBitrate: true)
        policy = SharedH264Policy(defaultBitrate: bitrate)
        resolution = SharedResolutionPolicy(targetBitrate: bitrate)
        queue.setSpecific(key: queueKey, value: true)
    }

    private func onQueue<T>(_ body: () -> T) -> T {
        if DispatchQueue.getSpecific(key: queueKey) != nil { return body() }
        return queue.sync(execute: body)
    }

    func makeProxy(packetizationMode: LKRTCH264PacketizationMode) -> SharedWebRTCEncoderProxy {
        onQueue {
            nextPeer += 1
            packetizationModes[nextPeer] = packetizationMode
            stat(nextPeer) { $0.live = true }
            return SharedWebRTCEncoderProxy(id: nextPeer, shared: self)
        }
    }

    func requestIDR() {
        onQueue { policy.requestIDR() }
    }

    func updateFps(_ fps: Int) {
        onQueue { self.fps = fps }
    }

    func encodedFrameCount() -> UInt64 {
        onQueue { encodedFrames }
    }

    func updateTargetBitrate(_ bitrate: Int) {
        onQueue { resolution.setTargetBitrate(bitrate) }
    }

    func setScaleObserver(_ observer: @escaping (Double) -> Void) {
        onQueue { scaleObserver = observer }
    }

    func resolutionStatus() -> (scale: Double, step: Int, changes: UInt64) {
        onQueue { (resolution.scale, resolution.step, resolution.changes) }
    }

    func starvedRecoveries() -> UInt64 {
        onQueue { policy.starvedRecoveries }
    }

    func lowLatencyFallbacks() -> UInt64 {
        onQueue { fallbacks }
    }

    func peerStats() -> [SharedEncoderPeerStats] {
        onQueue { peers.values.sorted { $0.peer < $1.peer } }
    }

    /// Queue-confined. Feeds the slowest peer's bitrate to the resolution policy.
    private func observeResolution() {
        let now = DispatchTime.now().uptimeNanoseconds
        if resolution.observe(bitrate: policy.bitrate, atNanoseconds: now) {
            scaleObserver?(resolution.scale)
        }
    }

    func start(peer: Int, settings: LKRTCVideoEncoderSettings) {
        onQueue {
            lastDeliveredTimestamp.removeValue(forKey: peer)
            policy.join(peer: peer, bitrate: Int(settings.startBitrate) * 1_000)
            stat(peer) { $0.starts &+= 1; $0.live = true }
            // libwebrtc also restarts a proxy when the frame size changes, so the
            // hold covers a canvas step as well as a real join.
            resolution.peerJoined(atNanoseconds: DispatchTime.now().uptimeNanoseconds)
        }
    }

    /// libwebrtc releases and re-initializes a proxy when it reconfigures the stream, for
    /// example on a frame size change. The proxy keeps its packetization mode across that,
    /// so the callback registered after the restart can deliver again.
    func release(peer: Int) {
        onQueue {
            stat(peer) { $0.releases &+= 1; $0.live = false }
            callbacks.removeValue(forKey: peer)
            lastDeliveredTimestamp.removeValue(forKey: peer)
            policy.leave(peer: peer)
            for timestamp in pending.keys {
                pending[timestamp]?.peers.remove(peer)
            }
            discardUnusedFrames()
        }
    }

    /// Unlike libwebrtc's temporary release, proxy destruction ends the peer lifetime.
    func remove(peer: Int) {
        onQueue {
            callbacks.removeValue(forKey: peer)
            lastDeliveredTimestamp.removeValue(forKey: peer)
            packetizationModes.removeValue(forKey: peer)
            peers.removeValue(forKey: peer)
            policy.leave(peer: peer)
            for timestamp in pending.keys {
                pending[timestamp]?.peers.remove(peer)
            }
            discardUnusedFrames()
        }
    }

    func stop() {
        onQueue {
            callbacks.removeAll()
            packetizationModes.removeAll()
            queuedFrame = nil
            backlog.stop()
            pending.removeAll()
            completed.removeAll()
            completedOrder.removeAll()
            lastEncodedTimestamp = nil
            lastDeliveredTimestamp.removeAll()
            stopped = true
        }
    }

    private func discardUnusedFrames() {
        guard callbacks.isEmpty else { return }
        queuedFrame = nil
        backlog.discardQueued()
        pending.removeAll()
    }

    func setCallback(_ callback: EncoderCallback?, peer: Int) {
        onQueue {
            lastDeliveredTimestamp.removeValue(forKey: peer)
            callbacks[peer] = callback.flatMap { value in
                packetizationModes[peer].map { (value, $0) }
            }
            stat(peer) { if callback != nil { $0.callbackSets &+= 1 } else { $0.callbackClears &+= 1 } }
            if callback != nil { policy.requestIDR() }
        }
    }

    func setBitrate(_ bitrateKbit: UInt32, peer: Int) {
        onQueue {
            policy.setBitrate(Int(bitrateKbit) * 1_000, peer: peer)
            observeResolution()
        }
    }

    func encode(_ frame: LKRTCVideoFrame, peer: Int, frameTypes: [NSNumber]) -> Int {
        guard let buffer = (frame.buffer as? LKRTCCVPixelBuffer)?.pixelBuffer else { return -1 }
        return onQueue {
            guard !stopped else { return -1 }
            stat(peer) { $0.encodeCalls &+= 1 }
            let timestamp = frame.timeStampNs
            let requestedIDR = frameTypes.contains { $0.intValue == LKRTCFrameType.videoFrameKey.rawValue }
            if let cached = completed[timestamp] {
                if requestedIDR, cached.encoded.kind != .keyframe { policy.requestIDR() }
                deliver(cached, to: peer)
                return 0
            }
            if pending[timestamp] != nil {
                if requestedIDR { policy.requestIDR() }
                pending[timestamp]?.peers.insert(peer)
                return 0
            }
            if queuedFrame?.forceIDR == true { policy.requestIDR() }
            guard let forceIDR = policy.beginFrame(timestamp: timestamp, requestedIDR: requestedIDR) else {
                // Older than the newest frame and out of the cache: this peer lags behind the
                // others. Without help it would never get a frame again. The next keyframe is
                // delivered to it as well (see `complete`).
                if policy.frameWasStale(peer: peer) {
                    print("[webrtc] Shared encoder peer \(peer) lags the cache; sending it the next keyframe")
                }
                return 0
            }
            observeResolution()
            let submission = backlog.submit(timestamp)
            if submission == .stale { return 0 }
            let metadata = Pending(
                peers: [peer], rtpTimestamp: UInt32(bitPattern: frame.timeStamp),
                captureTime: CMTime(value: timestamp, timescale: 1_000_000_000),
                width: Int32(frame.width), height: Int32(frame.height)
            )
            pending[timestamp] = metadata
            let next = QueuedFrame(timestamp: timestamp, buffer: buffer,
                                   forceIDR: forceIDR, bitrate: policy.bitrate)
            switch submission {
            case .start:
                startEncoding(next)
            case let .queued(replaced):
                if let replaced {
                    pending.removeValue(forKey: replaced)
                }
                queuedFrame = next
            case .stale:
                break
            }
            return 0
        }
    }

    private func startEncoding(_ frame: QueuedFrame) {
        let timestamp = frame.timestamp
        let fps = self.fps
        Task { [weak self] in
            guard let self, !Task.isCancelled else { return }
            await encoder.update(fps: fps, bitrate: frame.bitrate)
            let output = try? await encoder.encode(frame.buffer, forceKeyframe: frame.forceIDR)
            queue.async { self.complete(timestamp: timestamp, output: output) }
            // After delivery, so the frame does not wait for it. Reads can land out of order.
            let fallbacks = await encoder.lowLatencyFallbacks
            queue.async { self.fallbacks = max(self.fallbacks, fallbacks) }
        }
    }

    private func complete(timestamp: Int64, output: H264Encoder.Encoded?) {
        guard backlog.encodingTimestamp == timestamp else { return }
        let nextTimestamp = backlog.complete(timestamp)
        defer {
            if let next = queuedFrame, next.timestamp == nextTimestamp {
                queuedFrame = nil
                startEncoding(next)
            }
        }
        guard let metadata = pending.removeValue(forKey: timestamp) else { return }
        guard let output, let annexB = H264AnnexB.convert(
            avcc: output.avcc, parameterSets: output.parameterSets,
            keyframe: output.kind == .keyframe
        ) else {
            policy.requestIDR()
            if let queuedFrame {
                self.queuedFrame = QueuedFrame(
                    timestamp: queuedFrame.timestamp, buffer: queuedFrame.buffer,
                    forceIDR: true, bitrate: queuedFrame.bitrate
                )
            }
            return
        }
        let packet = Completed(
            timestamp: timestamp,
            previousTimestamp: output.kind == .keyframe ? nil : lastEncodedTimestamp,
            encoded: output, annexB: annexB, metadata: metadata
        )
        lastEncodedTimestamp = timestamp
        encodedFrames &+= 1
        completed[timestamp] = packet
        completedOrder.append(timestamp)
        if completedOrder.count > 8 {
            completed.removeValue(forKey: completedOrder.removeFirst())
        }
        let recoveringPeers = output.kind == .keyframe
            ? policy.takeStarvedPeers(excluding: metadata.peers) : []
        for peer in metadata.peers {
            deliver(packet, to: peer)
        }
        for peer in recoveringPeers {
            deliver(packet, to: peer)
        }
    }

    private func deliver(_ packet: Completed, to peer: Int) {
        guard let (callback, packetizationMode) = callbacks[peer] else {
            stat(peer) { $0.missingCallback &+= 1 }
            return
        }
        if let lastDelivered = lastDeliveredTimestamp[peer], packet.timestamp <= lastDelivered {
            return
        }
        // A peer that missed a reference frame resumes on the next shared IDR, without replay.
        if packet.encoded.kind == .delta,
           lastDeliveredTimestamp[peer] != packet.previousTimestamp {
            policy.frameWasStale(peer: peer)
            return
        }
        let image = LKRTCEncodedImage()
        image.buffer = packet.annexB
        image.encodedWidth = packet.metadata.width
        image.encodedHeight = packet.metadata.height
        image.timeStamp = packet.metadata.rtpTimestamp
        image.captureTimeMs = Int64(packet.metadata.captureTime.seconds * 1_000)
        image.frameType = packet.encoded.kind == .keyframe ? .videoFrameKey : .videoFrameDelta
        image.rotation = ._0
        let info = LKRTCCodecSpecificInfoH264()
        info.packetizationMode = packetizationMode
        let accepted = callback(image, info)
        stat(peer) { if accepted { $0.deliveries &+= 1 } else { $0.rejectedByCallback &+= 1 } }
        if accepted {
            lastDeliveredTimestamp[peer] = packet.timestamp
            policy.caughtUp(peer: peer)
        } else {
            policy.deliveryRejected(peer: peer, frameTimestamp: packet.timestamp)
        }
    }

}

private final class SharedWebRTCEncoderProxy: NSObject, LKRTCVideoEncoder {
    private let id: Int
    private let shared: SharedWebRTCEncoder

    init(id: Int, shared: SharedWebRTCEncoder) {
        self.id = id
        self.shared = shared
    }

    deinit {
        shared.remove(peer: id)
    }

    func setCallback(_ callback: EncoderCallback?) {
        shared.setCallback(callback, peer: id)
    }

    func startEncode(with settings: LKRTCVideoEncoderSettings, numberOfCores _: Int32) -> Int {
        shared.start(peer: id, settings: settings)
        return 0
    }

    func release() -> Int {
        shared.release(peer: id)
        return 0
    }

    func encode(_ frame: LKRTCVideoFrame, codecSpecificInfo _: (any LKRTCCodecSpecificInfo)?,
                frameTypes: [NSNumber]) -> Int {
        shared.encode(frame, peer: id, frameTypes: frameTypes)
    }

    func setBitrate(_ bitrateKbit: UInt32, framerate _: UInt32) -> Int32 {
        shared.setBitrate(bitrateKbit, peer: id)
        return 0
    }

    func implementationName() -> String { "serve-sim-shared-videotoolbox-h264" }

    func scalingSettings() -> LKRTCVideoEncoderQpThresholds? { nil }

    var resolutionAlignment: Int { 2 }
    var applyAlignmentToAllSimulcastLayers: Bool { true }
    var supportsNativeHandle: Bool { true }
}
