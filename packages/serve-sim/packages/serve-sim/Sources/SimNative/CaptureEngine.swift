import Foundation
import CoreVideo
import CoreMedia
import os
import StreamingPolicy

// JPEG and AVCC encode only while their HTTP transports have subscribers.
// Encoded bytes are handed to the node-swift binding, which marshals them onto
// the JS thread through a NodeAsyncQueue. WebRTC owns its session lifecycle.

struct Frame: Identifiable {
    let id = UUID()
    let pixelBuffer: CVPixelBuffer
    let timestamp: CMTime
    /// The viewer canvas the capture actor saw when it produced this frame.
    var canvas: Dimensions? = nil
    var captureGeneration: UInt64 = 0
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

struct RecordingAvailability {
    private(set) var unavailable = false

    mutating func finalizationFailed(_ error: Error) {
        let failure = error as NSError
        // A returned flush failure has completed teardown and invalidated its session.
        // A flush timeout may still have native work outstanding and remains blocked.
        unavailable = failure.domain != "serve-sim-recording" || ![13, 16, 17].contains(failure.code)
    }

    func checkStart() throws {
        guard !unavailable else {
            throw NSError(domain: "serve-sim-recording", code: 11, userInfo: [
                NSLocalizedDescriptionKey: "The recording encoder did not stop cleanly; restart serve-sim before recording again"
            ])
        }
    }
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
    private let screenID: UInt32?
    private let frameCapture = FrameCapture()
    private let nativeFrameMailbox = NativeFrameMailbox()
    private var phase = Phase.unstarted
    private var nativeFrameDeliveryActive = false
    private var nativeFrameDeliveryPending = false
    private var nativeFrameDeliveryGeneration: UInt64 = 0

    // MJPEG is stateless, so all subscribers share one encoder instance.
    private let mjpegEncoder: MJPEGEncoder
    private var avccEncoders = [UUID: AVCCEncoder]()
    private var options: CaptureEngineOptions

    private(set) var screenSize = Dimensions(width: 0, height: 0)
    private var consumers = [UUID: CaptureConsuming]()
    private var webRTCPublisher: WebRTCPublisher?
    private var webRTCConsumerId: UUID?
    private var webRTCEncodeCanvas = Dimensions(width: 0, height: 0)
    /// The shared H.264 canvas the publisher encodes at, as last reported.
    private var viewerCanvas = Dimensions(width: 0, height: 0)
    private var rebootSuspended = false
    // The device trait survives reboot while FrameCapture's boot-bound state is cleared.
    private var isFoldable = false
    private var captureGeneration: UInt64 = 0
    private var recording: NativeVideoRecorder?
    private var recordingStarting = false
    private var recordingFinalizing = false
    private var recordingFinishTask: Task<NativeRecordingResult, Error>?
    private var recordingAvailability = RecordingAvailability()
    private var recordingStateUnsubscribe: (@Sendable () async -> Void)?
    private var deviceStateSubscriptions: [UUID: @Sendable () async -> Void] = [:]
    private var lastViewerCanvasSequence: UInt64?
    private var frameContinuation: AsyncStream<Frame>.Continuation?
    private var cancelledWebRTCSessionIds = Set<String>()
    private var cancelledWebRTCSessionIdOrder: [String] = []

    init(deviceUDID: String, options: CaptureEngineOptions, screenID: UInt32? = nil) {
        self.deviceUDID = deviceUDID
        self.screenID = screenID
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
            await refreshSnapshotSize()
            let nativeFrameMailbox = self.nativeFrameMailbox
            let generation = captureGeneration
            try await frameCapture.start(deviceUDID: deviceUDID, screenID: screenID) { pixelBuffer, timestamp, canvas, screen in
                nativeFrameMailbox.publish(
                    pixelBuffer, timestamp: timestamp, wallClock: Date(),
                    deviceState: screen.recordingDeviceState
                )
                frameContinuation.yield(Frame(pixelBuffer: pixelBuffer, timestamp: timestamp, canvas: canvas, captureGeneration: generation))
            }
            isFoldable = await frameCapture.isFoldable
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
        webRTCEncodeCanvas = await frameCapture.webRTCEncodeCanvasSize()
            ?? Dimensions(width: 0, height: 0)
        Task {
            for await frame in frames {
                await handleFrame(frame)
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
        Task { [weak self] in await self?.refreshSnapshotSize() }
        return { await self.removeConsumer(id) }
    }

    private func removeConsumer(
        _ id: UUID
    ) {
        consumers.removeValue(forKey: id)
        Task { [weak self] in await self?.refreshSnapshotSize() }
    }

    /// The capture copy size follows the consumers: native while recording, the configured
    /// size for MJPEG and AVCC subscribers, otherwise the viewer canvas.
    private func refreshSnapshotSize() async {
        let size = CaptureSnapshotPolicy.maxDimension(
            recording: nativeFrameDeliveryActive,
            otherConsumers: consumers.keys.contains { $0 != webRTCConsumerId },
            configuredMaxDimension: options.maxDimension,
            viewerCanvasLongEdge: max(viewerCanvas.width, viewerCanvas.height)
        )
        await frameCapture.setSnapshotMaxDimension(size)
    }

    private func viewerCanvasChanged(_ canvas: Dimensions, sequence: UInt64,
                                     publisher: WebRTCPublisher) async {
        guard webRTCPublisher === publisher,
              lastViewerCanvasSequence.map({ sequence > $0 }) ?? true else { return }
        lastViewerCanvasSequence = sequence
        viewerCanvas = canvas
        await refreshSnapshotSize()
    }

    private func handleFrame(_ frame: Frame) async {
        guard phase == .running, frame.captureGeneration == captureGeneration else { return }
        screenSize = frame.pixelBuffer.dimensions
        // Another integrated panel can change geometry while this active panel
        // still delivers frames at the same dimensions. The capture actor sends
        // its current canvas with each frame, so this costs no actor hop.
        if let canvas = frame.canvas, canvas != webRTCEncodeCanvas {
            webRTCEncodeCanvas = canvas
            webRTCPublisher?.setEncodeCanvas(canvas)
        }
        for consumer in consumers.values {
            consumer.handleFrame(frame)
        }
    }

    func startNativeFrameDelivery() async -> (mailbox: NativeFrameMailbox, canvas: Dimensions)? {
        guard phase == .running, !nativeFrameDeliveryActive,
              !nativeFrameDeliveryPending else { return nil }
        nativeFrameDeliveryPending = true
        nativeFrameDeliveryGeneration &+= 1
        let generation = nativeFrameDeliveryGeneration
        let canvas = await frameCapture.recordingCanvasSize()
        guard phase == .running, generation == nativeFrameDeliveryGeneration else { return nil }
        nativeFrameDeliveryPending = false
        guard let canvas else { return nil }
        nativeFrameDeliveryActive = true
        await refreshSnapshotSize()
        guard phase == .running, generation == nativeFrameDeliveryGeneration else { return nil }
        nativeFrameMailbox.setActive(true)
        return (nativeFrameMailbox, canvas)
    }

    func stopNativeFrameDelivery() async {
        await stopRecordingStateUpdates()
        nativeFrameDeliveryGeneration &+= 1
        nativeFrameDeliveryPending = false
        nativeFrameMailbox.setActive(false)
        nativeFrameDeliveryActive = false
        await refreshSnapshotSize()
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
        Task { [weak self] in await self?.refreshSnapshotSize() }
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
            await refreshSnapshotSize()
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
        let pick = await frameCapture.pickTimings()
        let timings = await frameCapture.captureTimings()
        let poll = await frameCapture.pollTimings()
        let surface = await frameCapture.surfaceLossTimings()
        let flow = webRTCPublisher?.frameFlowCounts()
        let data = try JSONEncoder().encode(WebRTCSenderStatsReport(
            sessions: sessions,
            capture: WebRTCCaptureCounts(
                rebooting: rebootSuspended,
                pickCount: pick.count,
                pickSumMs: Double(pick.sumNs) / 1_000_000,
                pickMaxMs: Double(pick.maxNs) / 1_000_000,
                screenFrames: counts.screen,
                idleFrames: counts.idle,
                offeredFrames: flow?.offered,
                forwardedFrames: flow?.forwarded,
                sharedEncodedFrames: flow?.sharedEncoded,
                pumpRestarts: flow?.pumpRestarts,
                canvasMismatchDrops: flow?.canvasMismatchDrops,
                pumpDeferrals: flow?.pumpDeferrals,
                pumpRepeats: flow?.pumpRepeats,
                unchangedFrames: flow?.unchangedFrames,
                pumpTimerTicks: flow?.pumpTimerTicks,
                pumpTimerLateSumMs: flow.map { Double($0.pumpTimerLateSumNs) / 1_000_000 },
                pumpTimerLateMaxMs: flow.map { Double($0.pumpTimerLateMaxNs) / 1_000_000 },
                sourceSubmitCount: flow?.sourceSubmitCount,
                sourceSubmitSumMs: flow.map { Double($0.sourceSubmitSumNs) / 1_000_000 },
                sourceSubmitMaxMs: flow.map { Double($0.sourceSubmitMaxNs) / 1_000_000 },
                cpuFallbacks: timings.cpuFallbacks,
                poolDrops: timings.poolDrops,
                attempts: timings.attempts,
                stalls: timings.stalls,
                gapSumMs: Double(timings.gapSumNs) / 1_000_000,
                stallSumMs: Double(timings.stallSumNs) / 1_000_000,
                pollTicks: poll.ticks,
                pollLateSumMs: Double(poll.lateSumNs) / 1_000_000,
                surfaceLosses: surface.losses,
                surfaceLostMs: Double(surface.lostNs) / 1_000_000,
                rewires: surface.rewires
            ),
            encoder: webRTCPublisher?.encoderIdentity(
                liveCodecs: sessions.filter(\.connected).compactMap(\.codec)
            ),
            viewerResize: webRTCPublisher?.viewerResizeCounters(),
            sharedCanvas: webRTCPublisher?.sharedCanvasStatus(),
            sharedEncoderPeers: webRTCPublisher?.sharedEncoderPeerStats(),
            sharedEncoderFlow: webRTCPublisher?.sharedEncoderFlowStats()
        ))
        return String(decoding: data, as: UTF8.self)
    }

    func currentScreenSize() async -> CapturedScreenInfo {
        await frameCapture.getScreenSize()
            ?? CapturedScreenInfo(width: screenSize.width, height: screenSize.height)
    }

    func subscribeScreenChanges(_ callback: @escaping @Sendable () -> Void) async -> @Sendable () async -> Void {
        await frameCapture.subscribeScreenChanges(callback)
    }

    // @ref LLP 0001#recording-reboot-recovery — keep the writer/clock, replace boot-bound capture.
    func suspendForReboot() async {
        guard phase == .running else { return }
        rebootSuspended = true
        captureGeneration &+= 1
        webRTCPublisher?.suspendForReboot()
        await frameCapture.stop(preservingObservers: true)
        nativeFrameMailbox.setActive(false)
        recording?.suspendForReboot()
    }

    /// The caller has awaited bootstatus. Only a snapshot from the new capture can resume recording.
    func resumeAfterReboot() async throws {
        guard phase == .running, rebootSuspended else { return }
        let mailbox = nativeFrameMailbox
        let continuation = frameContinuation
        let generation = captureGeneration
        // Readiness is independent of recording ownership: stopping the writer may clear its mailbox.
        let readinessMailbox = NativeFrameMailbox()
        readinessMailbox.setActive(true)
        defer { readinessMailbox.setActive(false) }
        mailbox.setActive(nativeFrameDeliveryActive)
        do {
            try await frameCapture.start(deviceUDID: deviceUDID, screenID: screenID) { pixels, timestamp, canvas, screen in
                mailbox.publish(pixels, timestamp: timestamp, wallClock: Date(),
                                deviceState: screen.recordingDeviceState)
                readinessMailbox.publish(pixels, timestamp: timestamp, wallClock: Date())
                continuation?.yield(Frame(pixelBuffer: pixels, timestamp: timestamp, canvas: canvas, captureGeneration: generation))
            }
            let deadline = ContinuousClock.now + .seconds(30)
            while readinessMailbox.latest() == nil {
                guard phase == .running else { throw CancellationError() }
                guard ContinuousClock.now < deadline else {
                    throw recordingError(18, "No fresh capture frame after boot; recording remains paused")
                }
                try await Task.sleep(for: .milliseconds(25))
            }
            guard phase == .running else { throw CancellationError() }
            mailbox.setActive(nativeFrameDeliveryActive)
            rebootSuspended = false
            webRTCPublisher?.resumeAfterReboot()
        } catch {
            await frameCapture.stop(preservingObservers: true)
            mailbox.setActive(false)
            throw error
        }
    }

    func subscribeDeviceState(_ callback: @escaping @Sendable (DeviceStateSnapshot) -> Void,
                              onDetach: @escaping @Sendable () async -> Void = {}) async -> @Sendable () async -> Void {
        guard phase == .running else { await onDetach(); return {} }
        let id = UUID()
        let unsubscribe: @Sendable () async -> Void
        if isFoldable {
            let removeListener = await CoreDeviceBridge.shared.subscribeDeviceState(udid: deviceUDID, onChange: callback)
            unsubscribe = { await onDetach(); await removeListener() }
        } else {
            callback(await CoreDeviceBridge.shared.observedDeviceState(udid: deviceUDID))
            unsubscribe = onDetach
        }
        guard phase == .running else {
            await unsubscribe()
            return {}
        }
        deviceStateSubscriptions[id] = unsubscribe
        return { await self.removeDeviceStateSubscription(id) }
    }

    private func removeDeviceStateSubscription(_ id: UUID) async {
        if let unsubscribe = deviceStateSubscriptions.removeValue(forKey: id) { await unsubscribe() }
    }

    func stop() async throws {
        if phase == .stopped { return }
        phase = .stopped
        var recordingError: Error?
        if let recording {
            let finishing = recordingFinishTask ?? Task { try await recording.finish() }
            recordingFinishTask = finishing
            do {
                _ = try await finishing.value
            } catch {
                recordingError = error
            }
        }
        recording = nil
        await stopRecordingStateUpdates()
        let subscriptions = Array(deviceStateSubscriptions.values)
        deviceStateSubscriptions.removeAll()
        for unsubscribe in subscriptions { await unsubscribe() }
        nativeFrameDeliveryGeneration &+= 1
        nativeFrameDeliveryPending = false
        nativeFrameDeliveryActive = false
        nativeFrameMailbox.setActive(false)
        frameContinuation?.finish()
        frameContinuation = nil
        webRTCPublisher?.stop()
        webRTCPublisher = nil
        consumers.removeAll()
        avccEncoders.removeAll()
        await frameCapture.stop()
        if let recordingError { throw recordingError }
    }

    func startRecording(outputDirectory: String) async throws {
        guard phase == .running, !rebootSuspended else {
            throw recordingError(10, "Capture is not running; start the simulator session and retry")
        }
        try recordingAvailability.checkStart()
        guard recording == nil, !recordingStarting, !recordingFinalizing else {
            throw recordingError(12, "A recording is already active; stop it before starting another")
        }
        recordingStarting = true
        defer { recordingStarting = false }
        guard let delivery = await startNativeFrameDelivery() else {
            throw recordingError(13, "The native simulator display is unavailable; check that the device is booted and retry")
        }
        guard phase == .running, !rebootSuspended else {
            await stopNativeFrameDelivery()
            throw recordingError(14, "Capture stopped before recording could start; restart the session and retry")
        }
        do {
            await startRecordingStateUpdates()
            guard phase == .running else {
                throw recordingError(14, "Capture stopped before recording could start; restart the session and retry")
            }
            let recorder = try NativeVideoRecorder(
                mailbox: delivery.mailbox, canvas: delivery.canvas,
                outputDirectory: outputDirectory
            )
            recording = recorder
            recorder.start()
        } catch {
            await stopNativeFrameDelivery()
            throw error
        }
    }

    private func startRecordingStateUpdates() async {
        guard await frameCapture.isFoldable, phase == .running else { return }
        let udid = deviceUDID
        let mailbox = nativeFrameMailbox
        let bridge = CoreDeviceBridge.shared
        let generation = nativeFrameDeliveryGeneration
        // @ref LLP 0001#device-state-metadata — recording consumes only independently observed motion state
        let unsubscribe = await bridge.subscribeDeviceState(udid: udid) { snapshot in mailbox.updateHingeState(snapshot.state) }
        guard phase == .running, generation == nativeFrameDeliveryGeneration else { await unsubscribe(); return }
        recordingStateUnsubscribe = unsubscribe
    }

    private func stopRecordingStateUpdates() async {
        let unsubscribe = recordingStateUnsubscribe
        recordingStateUnsubscribe = nil
        await unsubscribe?()
    }

    func stopRecording() async throws -> String {
        guard !recordingFinalizing else {
            throw recordingError(16, "A recording is already stopping; wait for it to finish")
        }
        guard let recording else {
            throw recordingError(15, "No recording is active; start recording before stopping it")
        }
        recordingFinalizing = true
        let finishing = recordingFinishTask ?? Task { try await recording.finish() }
        recordingFinishTask = finishing
        do {
            let result = try await finishing.value
            self.recording = nil
            await stopNativeFrameDelivery()
            recordingFinalizing = false
            recordingFinishTask = nil
            print("[recording] encoder=\(result.encoderID) encoded=\(result.encodedFrames) written=\(result.writtenFrames) repeated=\(result.repeatedFrames) dropped=\(result.droppedTicks) coalesced=\(result.coalescedDrops) sourceUnavailable=\(result.sourceUnavailableTicks) transferPool=\(result.transferPoolDrops) inFlight=\(result.inFlightDrops) writer=\(result.writerDrops) backpressure=\(result.writerBackpressureTicks) encodeFailures=\(result.encodeFailures) maxInFlight=\(result.maxInFlight) meanEncodeMs=\(result.meanEncodeMs) maxEncodeMs=\(result.maxEncodeMs) finalizeMs=\(result.finalizeMs)")
            return result.manifestPath
        } catch {
            self.recording = nil
            recordingAvailability.finalizationFailed(error)
            await stopNativeFrameDelivery()
            recordingFinalizing = false
            recordingFinishTask = nil
            throw error
        }
    }

    private func recordingError(_ code: Int, _ message: String) -> NSError {
        NSError(domain: "serve-sim-recording", code: code,
                userInfo: [NSLocalizedDescriptionKey: message])
    }

    private func getWebRTCPublisher() -> WebRTCPublisher {
        if let webRTCPublisher {
            return webRTCPublisher
        }

        let publisher = WebRTCPublisher(
            maxFps: options.h264Fps,
            targetBitrate: options.h264Bitrate,
            maxDimension: options.maxDimension,
            encodeCanvas: webRTCEncodeCanvas
        )
        let consumerId = UUID()
        consumers[consumerId] = WebRTCConsumer(publisher: publisher)
        webRTCConsumerId = consumerId
        webRTCPublisher = publisher
        if rebootSuspended { publisher.suspendForReboot() }
        lastViewerCanvasSequence = nil
        publisher.setCanvasObserver { [weak self, weak publisher] canvas, sequence in
            guard let publisher else { return }
            Task { await self?.viewerCanvasChanged(canvas, sequence: sequence,
                                                   publisher: publisher) }
        }
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
