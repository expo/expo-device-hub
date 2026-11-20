import CoreMedia
import CoreVideo
import Foundation
import StreamingPolicy

struct PhysicalDeviceConnection: @unchecked Sendable {
    let description: PhysicalDeviceDescription
    let session: any PhysicalStreamSession
    let readOrientation: @Sendable () async -> String?
}

typealias PhysicalDeviceOpener = @Sendable (String) async throws -> PhysicalDeviceConnection

actor PhysicalScreenSource: ScreenSource {
    static let defaultIdleIntervalNs: UInt64 = 200_000_000
    static let defaultFirstFrameTimeoutNs: UInt64 = 15_000_000_000
    static let orientationRefreshInterval: Duration = .seconds(1)

    private let queue = DispatchSerialQueue(label: "physical-screen-source", qos: .userInteractive)
    nonisolated var unownedExecutor: UnownedSerialExecutor { queue.asUnownedSerialExecutor() }

    let isFoldable = false
    let supportsDevicePose = false

    private let open: PhysicalDeviceOpener
    private let idleIntervalNs: UInt64
    private let firstFrameTimeoutNs: UInt64
    private let nowNanoseconds: @Sendable () -> UInt64
    private var copier = PhysicalFrameCopier()
    private var connection: PhysicalDeviceConnection?
    private var display: PhysicalDisplayCandidate?
    private var deviceUDID: String?
    private var onFrame: ScreenSourceFrameHandler?
    private var onEnd: ScreenSourceEndHandler?
    private var snapshotMaxDimension = 0
    private var latest: CVPixelBuffer?
    private var content: PhysicalContentSize?
    private var orientation: String?
    private var generation: UInt64 = 0
    private var ended = false
    private var idleTimer: DispatchSourceTimer?
    private var orientationTask: Task<Void, Never>?
    private var firstFrame: CheckedContinuation<Void, Error>?
    private var lastEmitNs: UInt64 = 0
    private var decodedFrames: UInt64 = 0
    private var screenFrames: UInt64 = 0
    private var idleFrames: UInt64 = 0
    private var idleTicks: UInt64 = 0
    private var screenObservers: [UUID: @Sendable () -> Void] = [:]

    init(open: @escaping PhysicalDeviceOpener = { try await PhysicalScreenSource.openDevice(deviceUDID: $0) },
         idleIntervalNs: UInt64 = PhysicalScreenSource.defaultIdleIntervalNs,
         firstFrameTimeoutNs: UInt64 = PhysicalScreenSource.defaultFirstFrameTimeoutNs,
         nowNanoseconds: @escaping @Sendable () -> UInt64 = { DispatchTime.now().uptimeNanoseconds }) {
        self.open = open
        self.idleIntervalNs = idleIntervalNs
        self.firstFrameTimeoutNs = firstFrameTimeoutNs
        self.nowNanoseconds = nowNanoseconds
    }

    // @ref LLP 0027#opening-and-closing — returns after the first decoded frame; a stream that ends first rejects with iPhone disconnected
    func start(deviceUDID: String, screenID: UInt32?, onFrame: @escaping ScreenSourceFrameHandler,
               onEnd: @escaping ScreenSourceEndHandler) async throws {
        generation &+= 1
        let generation = self.generation
        ended = false
        let connection = try await open(deviceUDID)
        guard generation == self.generation else {
            await connection.session.stop()
            throw CancellationError()
        }
        guard let display = connection.description.display else {
            await connection.session.stop()
            throw PhysicalDeviceError.noDisplay
        }
        if let screenID, screenID != display.displayID {
            await connection.session.stop()
            throw PhysicalDeviceError.screenUnavailable(screenID)
        }
        self.connection = connection
        self.display = display
        self.deviceUDID = deviceUDID
        self.onFrame = onFrame
        self.onEnd = onEnd
        orientation = display.currentRotation.flatMap(SimulatorScreenOrientation.name(forRotation:))
        let queue = self.queue
        do {
            try await connection.session.start(
                onFrame: { [weak self] pixels in
                    queue.async { self?.assumeIsolated { $0.receive(pixels, generation: generation) } }
                },
                onEnd: { [weak self] cause in
                    queue.async { self?.assumeIsolated { $0.sessionEnded(cause, generation: generation) } }
                }
            )
            guard generation == self.generation else { throw CancellationError() }
            try await waitForFirstFrame(generation: generation)
        } catch {
            if generation == self.generation { await stop(preservingObservers: true) }
            throw error
        }
        startIdleTimer(generation: generation)
        startOrientationUpdates(generation: generation)
        fputs("[physical] Streaming \(deviceUDID) screen \(display.displayID) at \(content.map { "\($0.width)x\($0.height)" } ?? "?")\n", stderr)
    }

    private func waitForFirstFrame(generation: UInt64) async throws {
        guard latest == nil else { return }
        let timeout = firstFrameTimeoutNs
        let timer = Task { [weak self] in
            try? await Task.sleep(nanoseconds: timeout)
            await self?.resumeFirstFrame(generation: generation, error: PhysicalDeviceError.noFrames)
        }
        defer { timer.cancel() }
        try await withCheckedThrowingContinuation { (continuation: CheckedContinuation<Void, Error>) in
            if latest != nil {
                continuation.resume()
            } else if generation != self.generation || ended {
                continuation.resume(throwing: PhysicalDeviceError.noFrames)
            } else {
                firstFrame = continuation
            }
        }
    }

    private func resumeFirstFrame(generation: UInt64, error: Error?) {
        guard generation == self.generation, let firstFrame else { return }
        self.firstFrame = nil
        if let error { firstFrame.resume(throwing: error) } else { firstFrame.resume() }
    }

    private func receive(_ pixels: CVPixelBuffer, generation: UInt64) {
        guard generation == self.generation, !ended, let display else { return }
        let encoded = pixels.dimensions
        let content = PhysicalScreenPolicy.contentSize(
            encodedWidth: encoded.width, encodedHeight: encoded.height,
            nativeWidth: display.nativeWidth, nativeHeight: display.nativeHeight
        )
        latest = pixels
        decodedFrames &+= 1
        if content != self.content {
            let rotated = self.content.map { ($0.width > $0.height) != (content.width > content.height) } ?? false
            self.content = content
            if rotated { refreshOrientation(generation: generation) }
            notifyScreenObservers()
        }
        emit(idle: false)
        resumeFirstFrame(generation: generation, error: nil)
    }

    private func emit(idle: Bool) {
        guard !ended, let latest, let content, let display, let onFrame else { return }
        guard let copy = copier.videoFrame(latest, content: content, maxDimension: snapshotMaxDimension) else { return }
        lastEmitNs = nowNanoseconds()
        if idle { idleFrames &+= 1 } else { screenFrames &+= 1 }
        onFrame(copy, CMClockGetTime(CMClockGetHostTimeClock()),
                Dimensions(width: content.width, height: content.height),
                screenInfo(content: content, display: display))
    }

    private func screenInfo(content: PhysicalContentSize, display: PhysicalDisplayCandidate) -> CapturedScreenInfo {
        CapturedScreenInfo(
            width: content.width, height: content.height,
            display: SimDisplayMetadata(screenID: display.displayID, orientation: orientation,
                                        chromeIdentifier: display.chromeIdentifier, screenType: 0)
        )
    }

    private func startIdleTimer(generation: UInt64) {
        idleTimer?.cancel()
        let interval = DispatchTimeInterval.nanoseconds(Int(max(idleIntervalNs / 2, 1_000_000)))
        let timer = DispatchSource.makeTimerSource(flags: .strict, queue: queue)
        timer.schedule(deadline: .now() + interval, repeating: interval, leeway: .nanoseconds(0))
        timer.setEventHandler { [weak self] in
            self?.assumeIsolated { $0.idleTick(generation: generation) }
        }
        timer.resume()
        idleTimer = timer
    }

    // @ref LLP 0027#idle-floor — re-emit the last frame after 200 ms, the simulator's 5 fps floor
    private func idleTick(generation: UInt64) {
        guard generation == self.generation, !ended else { return }
        idleTicks &+= 1
        let now = nowNanoseconds()
        guard now >= lastEmitNs, now - lastEmitNs >= idleIntervalNs else { return }
        emit(idle: true)
    }

    private func startOrientationUpdates(generation: UInt64) {
        orientationTask?.cancel()
        orientationTask = Task { [weak self] in
            while !Task.isCancelled {
                try? await Task.sleep(for: Self.orientationRefreshInterval)
                guard !Task.isCancelled, let self else { return }
                await self.readOrientation(generation: generation)
            }
        }
    }

    private func refreshOrientation(generation: UInt64) {
        Task { [weak self] in await self?.readOrientation(generation: generation) }
    }

    private func readOrientation(generation: UInt64) async {
        guard generation == self.generation, !ended, let connection else { return }
        let read = await connection.readOrientation()
        guard generation == self.generation, !ended, let read else { return }
        guard read != orientation else { return }
        orientation = read
        notifyScreenObservers()
    }

    private func notifyScreenObservers() {
        for notify in screenObservers.values { notify() }
    }

    // @ref LLP 0027#ending-device-disconnected — end once: stop the stream, drop CoreDevice's cached capabilities, report iPhone disconnected
    private func sessionEnded(_ cause: String, generation: UInt64) {
        guard generation == self.generation, !ended else { return }
        ended = true
        fputs("[physical] \(deviceUDID ?? "iPhone") stream ended: \(cause)\n", stderr)
        idleTimer?.cancel()
        idleTimer = nil
        orientationTask?.cancel()
        orientationTask = nil
        resumeFirstFrame(generation: generation, error: PhysicalDeviceError.disconnected)
        let handler = onEnd
        onEnd = nil
        if let connection {
            Task { await connection.session.stop() }
        }
        if let deviceUDID {
            Task { await CoreDeviceBridge.shared.resetForNewCapture(udid: deviceUDID) }
        }
        handler?(.iPhoneDisconnected)
    }

    func stop(preservingObservers: Bool = false) async {
        generation &+= 1
        idleTimer?.cancel()
        idleTimer = nil
        orientationTask?.cancel()
        orientationTask = nil
        if let firstFrame {
            self.firstFrame = nil
            firstFrame.resume(throwing: CancellationError())
        }
        let connection = self.connection
        self.connection = nil
        let wasEnded = ended
        ended = false
        latest = nil
        content = nil
        display = nil
        orientation = nil
        onFrame = nil
        onEnd = nil
        lastEmitNs = 0
        copier.reset()
        if !preservingObservers { screenObservers.removeAll() }
        deviceUDID = nil
        if let connection, !wasEnded { await connection.session.stop() }
    }

    func setSnapshotMaxDimension(_ value: Int) {
        snapshotMaxDimension = max(0, value)
    }

    func screenshotPixels(screenID: UInt32) async throws -> (pixels: CVPixelBuffer, orientation: String?, screen: RecordingScreen?) {
        guard let display, !ended, let latest, let content else { throw PhysicalDeviceError.noFrames }
        guard screenID == display.displayID else { throw PhysicalDeviceError.screenUnavailable(screenID) }
        guard let pixels = copier.screenshot(latest, content: content) else { throw PhysicalDeviceError.noFrames }
        return (pixels, orientation, nil)
    }

    func getScreenSize() -> CapturedScreenInfo? {
        guard let content, let display else { return nil }
        return screenInfo(content: content, display: display)
    }

    func activeScreenID() async throws -> UInt32 {
        guard let display else { throw PhysicalDeviceError.noDisplay }
        return display.displayID
    }

    func subscribeScreenChanges(_ callback: @escaping @Sendable () -> Void) -> @Sendable () async -> Void {
        let id = UUID()
        screenObservers[id] = callback
        return { [weak self] in await self?.removeScreenObserver(id) }
    }

    private func removeScreenObserver(_ id: UUID) { screenObservers.removeValue(forKey: id) }

    func webRTCEncodeCanvasSize() -> Dimensions? {
        content.map { Dimensions(width: $0.width, height: $0.height) }
    }

    func recordingCanvasSize() -> Dimensions? {
        content.map { Dimensions(width: $0.width + $0.width % 2, height: $0.height + $0.height % 2) }
    }

    func frameCounts() -> (screen: UInt64, idle: UInt64) { (screen: screenFrames, idle: idleFrames) }

    func pickTimings() -> (count: UInt64, sumNs: UInt64, maxNs: UInt64) { (count: 0, sumNs: 0, maxNs: 0) }

    func captureTimings() -> (attempts: UInt64, gapSumNs: UInt64, stalls: UInt64, stallSumNs: UInt64,
                              cpuFallbacks: UInt64, poolDrops: UInt64) {
        (attempts: decodedFrames, gapSumNs: 0, stalls: 0, stallSumNs: 0, cpuFallbacks: 0, poolDrops: copier.poolDrops)
    }

    func pollTimings() -> (ticks: UInt64, lateSumNs: UInt64) { (ticks: idleTicks, lateSumNs: 0) }

    func surfaceLossTimings() -> (losses: UInt64, lostNs: UInt64, rewires: UInt64) { (losses: 0, lostNs: 0, rewires: 0) }

    deinit {
        idleTimer?.cancel()
        orientationTask?.cancel()
    }
}

extension PhysicalScreenSource {
    static func openDevice(deviceUDID: String) async throws -> PhysicalDeviceConnection {
        let (device, description, display) = try await lookUp(deviceUDID: deviceUDID)
        let session = CoreDeviceMediaStreamSession(device: device) { fputs("[physical] \($0)\n", stderr) }
        let displayID = display.displayID
        return PhysicalDeviceConnection(
            description: description, session: session,
            readOrientation: { await liveOrientation(deviceUDID: deviceUDID, displayID: displayID) }
        )
    }

    // @ref LLP 0027#orientation — frames are the panel as mounted, so input keeps the client's panel coordinates and needs no rotation map
    static func inputTarget(deviceUDID: String) async throws -> ScreenInputTarget {
        let (_, _, display) = try await lookUp(deviceUDID: deviceUDID)
        let displayID = display.displayID
        return ScreenInputTarget(
            transport: .coreDeviceOnly,
            defaultScreenID: displayID,
            screenSize: Dimensions(width: Int(display.nativeWidth), height: Int(display.nativeHeight)),
            nativeScreenRotations: [:],
            isFoldable: false,
            simDevice: nil,
            connect: {
                let device = try await CoreDeviceBridge.shared.remoteDevice(udid: deviceUDID)
                try await CoreDeviceMediaStreamCalls.connect(device)
            }
        )
    }

    private static func lookUp(deviceUDID: String) async throws
        -> (CoreDeviceRemoteDevice, PhysicalDeviceDescription, PhysicalDisplayCandidate) {
        let host = PhysicalDeviceHost.support()
        guard host == .supported else { throw PhysicalDeviceError.unsupported(host) }
        let device = try await CoreDeviceBridge.shared.remoteDevice(udid: deviceUDID)
        let description = try PhysicalDeviceDescription.read(device)
        let support = PhysicalDeviceSupport.device(osVersion: description.osVersion)
        guard support == .supported else { throw PhysicalDeviceError.unsupported(support) }
        guard let display = description.display else { throw PhysicalDeviceError.noDisplay }
        return (device, description, display)
    }

    static func liveOrientation(deviceUDID: String, displayID: UInt32) async -> String? {
        guard let displays = try? await CoreDeviceDisplayInfo.read(udid: deviceUDID) else { return nil }
        return displays.first { $0.screenID == displayID }?.orientation
    }
}
