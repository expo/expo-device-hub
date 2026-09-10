import Foundation
import CoreVideo
import CoreMedia
import os

// JPEG and AVCC encode only while their HTTP transports have subscribers.
// Encoded bytes are handed to the node-swift binding, which marshals them onto
// the JS thread through a NodeAsyncQueue. WebRTC owns its session lifecycle.

struct Frame: Identifiable {
    let id = UUID()
    let pixelBuffer: CVPixelBuffer
    let timestamp: CMTime
}

protocol FrameEncoder {
    associatedtype Encoded
    func encode(_ frame: Frame) async throws -> Encoded
}

struct CaptureEngineOptions: Sendable {
    var mjpegFps: Int
    var mjpegQuality: Double
    var maxDimension: Int
    var h264Fps: Int
    var h264Bitrate: Int
}

protocol CaptureConsuming: Sendable {
    // this is intentionally synchronous. CaptureEngine sends all frames to all consumers,
    // and lets them handle internal backpressure as they see fit. if instead this were async
    // (and CaptureEngine waited for all consumers to finish), a single bad consumer could
    // jam up the entire pipeline.
    func handleFrame(_ frame: Frame)
}

actor CaptureConsumer<E: FrameEncoder>: CaptureConsuming {
    nonisolated let continuation: AsyncStream<Frame>.Continuation

    init(
        encoder: E,
        onFrame: @escaping @isolated(any) (E.Encoded) async -> Void
    ) {
        let (stream, continuation) = AsyncStream.makeStream(
            of: Frame.self,
            // drop old frames if there's backpressure
            bufferingPolicy: .bufferingNewest(1)
        )
        self.continuation = continuation
        Task {
            _ = onFrame.isolation
            for await frame in stream {
                do {
                    let encoded = try await encoder.encode(frame)
                    await onFrame(encoded)
                } catch {
                    streamDiagnosticLog("[stream] frame encode failed: \(error)")
                    continue
                }
            }
        }
    }

    nonisolated func handleFrame(_ frame: Frame) {
        continuation.yield(frame)
    }

    deinit { continuation.finish() }
}

actor CaptureEngine {
    private enum Phase {
        case unstarted
        case starting
        case running
        case stopped
    }

    private let deviceUDID: String
    private let frameCapture = FrameCapture()
    private var phase = Phase.unstarted

    // MJPEG is stateless, so all subscribers share one encoder instance.
    private let mjpegEncoder: MJPEGEncoder
    private var avccEncoders = [UUID: AVCCEncoder]()
    private var options: CaptureEngineOptions

    private(set) var screenSize = Dimensions(width: 0, height: 0)
    private var consumers = [UUID: CaptureConsuming]()
    private var webRTCPublisher: WebRTCPublisher?
    private var frameContinuation: AsyncStream<Frame>.Continuation?
    private var cancelledWebRTCSessionIds = Set<String>()
    private var cancelledWebRTCSessionIdOrder: [String] = []

    init(deviceUDID: String, options: CaptureEngineOptions) {
        self.deviceUDID = deviceUDID
        self.options = options
        self.mjpegEncoder = MJPEGEncoder(
            fps: options.mjpegFps,
            quality: options.mjpegQuality,
            maxDimension: options.maxDimension
        )
    }

    func start() async throws {
        guard phase == .unstarted else { return }
        phase = .starting
        // Latch `started` only after capture actually begins: if start() throws
        // (e.g. device not booted), a later retry should still be allowed.
        let (frames, frameContinuation) = AsyncStream.makeStream(
            of: Frame.self,
            // drop old frames if there's backpressure
            bufferingPolicy: .bufferingNewest(1)
        )
        self.frameContinuation = frameContinuation
        do {
            try await frameCapture.start(deviceUDID: deviceUDID) { pixelBuffer, timestamp in
                frameContinuation.yield(Frame(pixelBuffer: pixelBuffer, timestamp: timestamp))
            }
        } catch {
            frameContinuation.finish()
            self.frameContinuation = nil
            if phase == .starting { phase = .unstarted }
            throw error
        }
        guard phase == .starting else {
            frameContinuation.finish()
            self.frameContinuation = nil
            await frameCapture.stop()
            return
        }
        Task {
            for await frame in frames {
                handleFrame(frame)
            }
        }
        phase = .running
    }

    private func addConsumer<E: FrameEncoder>(
        id: UUID = UUID(),
        encoder: E,
        onFrame: sending @escaping @isolated(any) (E.Encoded) async -> Void
    ) -> (@Sendable () async -> Void) {
        let consumer = CaptureConsumer(encoder: encoder) { [weak self] encoded in
            guard let self, await self.phase == .running else { return }
            await onFrame(encoded)
        }
        consumers[id] = consumer
        return { await self.removeConsumer(id) }
    }

    private func removeConsumer(
        _ id: UUID
    ) {
        consumers.removeValue(forKey: id)
    }

    private func handleFrame(_ frame: Frame) {
        guard phase == .running else { return }
        screenSize = frame.pixelBuffer.dimensions
        for consumer in consumers.values {
            consumer.handleFrame(frame)
        }
    }

    func addMJPEGConsumer(
        onFrame: sending @escaping (Dimensions, Data) async -> Void
    ) -> (@Sendable () async -> Void) {
        return addConsumer(encoder: mjpegEncoder, onFrame: { [weak self] data in
            guard let self, let data else { return }
            await onFrame(screenSize, data)
        })
    }

    func addAVCCConsumer(
        onFrame: sending @escaping (Dimensions, Data, Int32) async -> Void
    ) -> (@Sendable () async -> Void) {
        let id = UUID()
        let encoder = AVCCEncoder(
            fps: options.h264Fps,
            bitrate: options.h264Bitrate,
            maxDimension: options.maxDimension
        )
        avccEncoders[id] = encoder
        streamDiagnosticLog("[stream:avcc] subscriber added count=\(avccEncoders.count)")
        _ = addConsumer(id: id, encoder: encoder) { [weak self] encoded in
            let flagDescription: Int32 = 1 << 0
            let flagKeyframe: Int32 = 1 << 1

            guard let self, let encoded else { return }
            if let description = encoded.description {
                await onFrame(
                    screenSize,
                    AVCCEnvelope.description(avcc: description),
                    flagDescription,
                )
            }
            switch encoded.kind {
            case .keyframe:
                await onFrame(
                    screenSize,
                    AVCCEnvelope.keyframe(avcc: encoded.avcc),
                    flagKeyframe,
                )
            case .delta:
                await onFrame(
                    screenSize,
                    AVCCEnvelope.delta(avcc: encoded.avcc),
                    0,
                )
            }
        }
        return { await self.removeAVCCConsumer(id) }
    }

    private func removeAVCCConsumer(_ id: UUID) {
        consumers.removeValue(forKey: id)
        avccEncoders.removeValue(forKey: id)
        streamDiagnosticLog("[stream:avcc] subscriber removed count=\(avccEncoders.count)")
    }

    func updateSettings(_ options: CaptureEngineOptions) async {
        let previous = self.options
        self.options = options
        if previous.mjpegFps != options.mjpegFps
            || previous.mjpegQuality != options.mjpegQuality
            || previous.maxDimension != options.maxDimension {
            await mjpegEncoder.update(
                fps: options.mjpegFps,
                quality: options.mjpegQuality,
                maxDimension: options.maxDimension
            )
        }
        if previous.h264Fps != options.h264Fps
            || previous.h264Bitrate != options.h264Bitrate
            || previous.maxDimension != options.maxDimension {
            // Actor methods are reentrant at `await`; snapshot the encoders so
            // an unsubscribe cannot mutate the dictionary during iteration.
            for encoder in Array(avccEncoders.values) {
                await encoder.update(
                    fps: options.h264Fps,
                    bitrate: options.h264Bitrate,
                    maxDimension: options.maxDimension
                )
            }
            await webRTCPublisher?.updateSettings(
                maxFps: options.h264Fps,
                targetBitrate: options.h264Bitrate,
                maxDimension: options.maxDimension
            )
        }
    }

    func handleWebRTCOffer(_ offerJson: String) async throws -> String {
        let request = try JSONDecoder().decode(WebRTCOfferPayload.self, from: Data(offerJson.utf8))
        guard request.type == "offer", !request.sessionId.isEmpty else {
            throw NSError(
                domain: "serve-sim.webrtc",
                code: 1,
                userInfo: [NSLocalizedDescriptionKey: "Invalid WebRTC offer"]
            )
        }
        guard !cancelledWebRTCSessionIds.contains(request.sessionId) else {
            throw NSError(
                domain: "serve-sim.webrtc",
                code: 1,
                userInfo: [NSLocalizedDescriptionKey: "WebRTC session was cancelled"]
            )
        }
        let answer = try await getWebRTCPublisher().handleOffer(request)
        let data = try JSONEncoder().encode(answer)
        return String(decoding: data, as: UTF8.self)
    }

    func closeWebRTCSession(_ sessionId: String) async {
        rememberCancelledWebRTCSession(sessionId)
        if let webRTCPublisher {
            await webRTCPublisher.closeSession(sessionId)
        }
    }

    func webRTCSenderStats(sessionId: String? = nil) async throws -> String {
        let sessions = await webRTCPublisher?.senderStatistics(sessionId: sessionId) ?? []
        let counts = await frameCapture.frameCounts()
        let flow = webRTCPublisher?.frameFlowCounts()
        let data = try JSONEncoder().encode(WebRTCSenderStatsReport(
            sessions: sessions,
            capture: WebRTCCaptureCounts(
                screenFrames: counts.screen,
                idleFrames: counts.idle,
                offeredFrames: flow?.offered,
                forwardedFrames: flow?.forwarded,
                pumpRestarts: flow?.pumpRestarts
            )
        ))
        return String(decoding: data, as: UTF8.self)
    }

    func currentScreenSize() -> Dimensions {
        screenSize
    }

    func stop() async {
        if phase == .stopped { return }
        phase = .stopped
        frameContinuation?.finish()
        frameContinuation = nil
        webRTCPublisher?.stop()
        webRTCPublisher = nil
        consumers.removeAll()
        avccEncoders.removeAll()
        await frameCapture.stop()
    }

    private func getWebRTCPublisher() -> WebRTCPublisher {
        if let webRTCPublisher {
            return webRTCPublisher
        }

        let publisher = WebRTCPublisher(
            maxFps: options.h264Fps,
            targetBitrate: options.h264Bitrate,
            maxDimension: options.maxDimension
        )
        consumers[UUID()] = WebRTCConsumer(publisher: publisher)
        webRTCPublisher = publisher
        return publisher
    }

    private func rememberCancelledWebRTCSession(_ sessionId: String) {
        guard cancelledWebRTCSessionIds.insert(sessionId).inserted else { return }
        cancelledWebRTCSessionIdOrder.append(sessionId)
        if cancelledWebRTCSessionIdOrder.count > 64 {
            cancelledWebRTCSessionIds.remove(cancelledWebRTCSessionIdOrder.removeFirst())
        }
    }
}

final class WebRTCConsumer: CaptureConsuming, @unchecked Sendable {
    private let publisher: WebRTCPublisher

    init(publisher: WebRTCPublisher) {
        self.publisher = publisher
    }

    func handleFrame(_ frame: Frame) {
        publisher.sendFrame(frame.pixelBuffer, timestamp: frame.timestamp)
    }
}

actor MJPEGEncoder: FrameEncoder {
    private var videoEncoder: VideoEncoder
    private let scaler = PixelBufferScaler()
    private var frameRateGate: FrameRateGate
    private var maxDimension: Int
    private var lastImage: (UUID, Data)?
    private var inFlight: (id: UUID, generation: Int, task: Task<Data, Error>)?
    private var settingsGeneration = 0

    init(fps: Int, quality: Double, maxDimension: Int) {
        self.videoEncoder = VideoEncoder(quality: CGFloat(quality))
        self.frameRateGate = FrameRateGate(fps: fps)
        self.maxDimension = maxDimension
    }

    func encode(_ frame: Frame) async throws -> Data? {
        if let (id, data) = lastImage, id == frame.id { return data }
        if let inFlight {
            guard inFlight.id == frame.id else { return nil }
            let data = try await inFlight.task.value
            return settingsGeneration == inFlight.generation ? data : nil
        }
        guard frameRateGate.shouldEncode() else { return nil }
        guard let pixelBuffer = scaler.scale(frame.pixelBuffer, maxDimension: maxDimension) else {
            return nil
        }
        let generation = settingsGeneration
        let encoder = videoEncoder
        let task = Task { try await encoder.encode(pixelBuffer: pixelBuffer) }
        inFlight = (frame.id, generation, task)
        do {
            let data = try await task.value
            if inFlight?.id == frame.id {
                inFlight = nil
            }
            guard settingsGeneration == generation else { return nil }
            lastImage = (frame.id, data)
            return data
        } catch {
            if inFlight?.id == frame.id { inFlight = nil }
            throw error
        }
    }

    func update(fps: Int, quality: Double, maxDimension: Int) {
        frameRateGate.update(fps: fps)
        videoEncoder = VideoEncoder(quality: CGFloat(quality))
        self.maxDimension = maxDimension
        settingsGeneration += 1
        lastImage = nil
    }
}

actor AVCCEncoder: FrameEncoder {
    private let h264Encoder: H264Encoder
    private let scaler = PixelBufferScaler()
    private var frameRateGate: FrameRateGate
    private var maxDimension: Int
    private var forceKeyframe = true

    init(fps: Int, bitrate: Int, maxDimension: Int) {
        self.h264Encoder = H264Encoder(fps: fps, bitrate: bitrate)
        self.frameRateGate = FrameRateGate(fps: fps)
        self.maxDimension = maxDimension
    }

    func encode(_ frame: Frame) async throws -> H264Encoder.Encoded? {
        guard frameRateGate.shouldEncode() else { return nil }
        guard let pixelBuffer = scaler.scale(frame.pixelBuffer, maxDimension: maxDimension) else {
            return nil
        }
        let result = try await h264Encoder.encode(
            pixelBuffer,
            forceKeyframe: forceKeyframe,
        )
        forceKeyframe = false
        return result
    }

    func update(fps: Int, bitrate: Int, maxDimension: Int) async {
        frameRateGate.update(fps: fps)
        self.maxDimension = maxDimension
        forceKeyframe = true
        await h264Encoder.update(fps: fps, bitrate: bitrate)
    }

    deinit {
        Task { [h264Encoder] in await h264Encoder.stop() }
    }
}
