import Foundation
import CoreVideo
import CoreMedia
import CoreGraphics
import IOSurface
import ObjectiveC
import StreamingPolicy

typealias ScreenFrameCallback = @convention(block) () -> Void
typealias ScreenSurfacesChangedCallback = @convention(block) (IOSurface?, IOSurface?) -> Void
typealias ScreenPropertiesChangedCallback = @convention(block) (AnyObject?) -> Void

private struct ScreenCallbackBlocks {
    let frame: ScreenFrameCallback
    let surfacesChanged: ScreenSurfacesChangedCallback
    let propertiesChanged: ScreenPropertiesChangedCallback
}

struct CapturedScreenInfo {
    let width: Int
    let height: Int
    var display: SimDisplayMetadata?
}

/// Headless simulator frame capture via direct IOSurface access.
///
/// Uses SimulatorKit frame callbacks (via a private Objective-C protocol)
/// plus an IOSurface seed poll. Some virtualized SimulatorKit runtimes deliver
/// frame callbacks well below the display cadence; polling catches those
/// surface changes without duplicating unchanged frames. Maintains a 5fps idle
/// floor for late-joining clients.
///
/// Pipeline: IOSurface (shared memory) → CVPixelBuffer (zero-copy) → H.264 encode
actor FrameCapture {
    private let queue = DispatchSerialQueue(label: "frame-capture", qos: .userInteractive)
    nonisolated var unownedExecutor: UnownedSerialExecutor { queue.asUnownedSerialExecutor() }

    private var photocopier = Photocopier()
    private var snapshotMaxDimension = 0
    private var pollTicks: UInt64 = 0
    private var pollLateSumNs: UInt64 = 0
    private var pollGrid: PollDeadlineGrid?
    private var onFrame: ((CVPixelBuffer, CMTime) -> Void)?
    private var screenObservers: [UUID: @Sendable () -> Void] = [:]
    private var frameCount: UInt64 = 0
    /// Counted by which path produced the frame, callback or idle deadline.
    private var pickCount: UInt64 = 0
    private var pickSumNs: UInt64 = 0
    private var pickMaxNs: UInt64 = 0
    private var screenFrameCount: UInt64 = 0
    private var idleFrameCount: UInt64 = 0
    private var captureLastEntryNs: UInt64 = 0
    private var captureAttempts: UInt64 = 0
    private var captureGapSumNs: UInt64 = 0
    private var captureStalls: UInt64 = 0
    private var captureStallSumNs: UInt64 = 0
    private(set) var capturedWidth: Int = 0
    private(set) var capturedHeight: Int = 0
    private var surfacePollTimer: DispatchSourceTimer?
    private var lastCaptureTime: ContinuousClock.Instant = .now
    private var lastSeeds: [ObjectIdentifier: UInt32] = [:]
    private var lastRewireAttempt: ContinuousClock.Instant = .now
    /// Interval at which the surface poll re-emits the current frame even when
    /// the simulator isn't rendering anything new. This is load-bearing for two
    /// consumers:
    /// 1. Browsers rendering `<img src="…/stream.mjpeg">` only render a multipart
    ///    chunk once the NEXT boundary arrives, so a single static frame never
    ///    paints until something changes.
    /// 2. Any upstream MJPEG→WebSocket relay only caches a frame when at least
    ///    one subscriber is due for it — a late-joining relay subscriber on an
    ///    idle sim never gets a cached frame to show.
    /// Re-emitting at ~5 fps fixes both without meaningful CPU cost.
    private static let idleInterval: ContinuousClock.Duration = .milliseconds(200)
    private static let rewireInterval: ContinuousClock.Duration = .seconds(1)
    /// The surfaces-changed callback is the primary invalidation. Some virtualized
    /// runtimes deliver it unreliably, so re-pick on a slow timer as well.
    private static let pickRevalidateInterval: ContinuousClock.Duration = .seconds(1)
    /// A gap this long is a visible hitch rather than ordinary jitter.
    private static let stallThresholdNanoseconds: UInt64 = 100_000_000

    private var descriptors: [NSObject] = []
    private var callbackUUIDs: [ObjectIdentifier: UUID] = [:]
    // Keep private-API callback blocks alive until their registrations are removed.
    private var callbackBlocks: [ObjectIdentifier: ScreenCallbackBlocks] = [:]
    private var framebufferSurfaces: [ObjectIdentifier: IOSurface] = [:]
    private var screenMetadata: [ObjectIdentifier: SimDisplayMetadata] = [:]
    private var fixedScreenID: UInt32?
    private var deviceUDID: String?
    private var authoritativeDisplay: CoreDeviceDisplayState?
    private var displayInfoTask: Task<Void, Never>?
    private var displayRefreshTask: Task<Void, Never>?
    private var displayRefreshRequested = false
    private var displayConfigurationReady = false
    private var captureGeneration: UInt64 = 0
    private var capturedDisplay: SimDisplayMetadata?
    private var bestSurfaceKey: ObjectIdentifier?
    private var lastPickAttempt: ContinuousClock.Instant?
    private var ioClient: NSObject?

    func start(deviceUDID: String, screenID: UInt32? = nil, onFrame: @escaping @Sendable (CVPixelBuffer, CMTime) -> Void) async throws {
        self.onFrame = onFrame
        self.deviceUDID = deviceUDID
        fixedScreenID = screenID
        displayConfigurationReady = false
        captureGeneration &+= 1
        let generation = captureGeneration

        SimFrameworks.load()
        guard let device = Self.findSimDevice(udid: deviceUDID) else {
            throw makeError(1, "Device \(deviceUDID) not found")
        }

        let state = device.value(forKey: "stateString") as? String ?? "unknown"
        guard state == "Booted" else {
            throw makeError(2, "Device not booted (state: \(state))")
        }

        // Recreate CoreDevice's boot-bound manager before HID or display
        // election asks for capabilities from this boot.
        if HIDInjector.readDisplayProfile(device: device).resetsBootBoundStateOnCapture(fixedScreenID: screenID) {
            await CoreDeviceBridge.shared.resetForNewCapture(udid: deviceUDID)
            guard generation == captureGeneration else { throw CancellationError() }
        }

        guard let io = device.perform(NSSelectorFromString("io"))?.takeUnretainedValue() as? NSObject else {
            throw makeError(3, "Failed to get device IO")
        }
        self.ioClient = io

        try wireUpFramebuffer()
        // Main capture follows authoritative display election. Independent
        // fixed-panel feeds observe their own surface immediately, including
        // during a native display handoff, without waiting for that election.
        let integratedIDs = Set(screenMetadata.values.filter { $0.screenType == 0 }.map(\.screenID))
        if fixedScreenID == nil, integratedIDs.count == 2 {
            // Only foldable main feeds use CoreDevice display election.
            let displays = try? await CoreDeviceDisplayInfo.read(udid: deviceUDID)
            guard generation == captureGeneration else { throw CancellationError() }
            if let displays {
                updateDisplayInfo(displays)
            }
            startDisplayInfoUpdates()
        }
        displayConfigurationReady = true
        captureFrame(force: true)
        startSurfacePoller()
        print("[capture] Frame callbacks registered + 60Hz IOSurface poll + 5fps idle floor")
    }

    /// Find all framebuffer display descriptors, register callbacks on each,
    /// and cache them. Safe to re-call if the cached descriptors become stale.
    ///
    /// The simulator exposes multiple `com.apple.framebuffer.display` ports
    /// (integrated panels + secondary planes/overlays). Listen on all of them
    /// so `captureFrame()` can follow CoreDevice's currently active panel.
    private func wireUpFramebuffer() throws {
        guard let io = ioClient else {
            throw makeError(3, "No IO client")
        }

        // Refresh ports — descriptors are created lazily.
        io.perform(NSSelectorFromString("updateIOPorts"))

        let candidates = try findFramebufferDescriptors(io: io)

        unregisterCallbacks()
        lastSeeds.removeAll()
        framebufferSurfaces.removeAll()
        screenMetadata.removeAll()
        invalidatePick()
        descriptors = candidates

        // Registering screen callbacks is what causes SimulatorKit to wire the
        // display pipeline to our client and populate `framebufferSurface`.
        do {
            for desc in candidates {
                screenMetadata[ObjectIdentifier(desc)] = SimDisplayMetadata.read(from: desc)
                try registerFrameCallbacks(desc: desc)
            }
        } catch {
            unregisterCallbacks()
            descriptors.removeAll()
            throw error
        }

        if let (_, surface) = pickBestSurface() {
            capturedWidth = IOSurfaceGetWidth(surface)
            capturedHeight = IOSurfaceGetHeight(surface)
            print("[capture] Framebuffer: \(capturedWidth)x\(capturedHeight) (direct IOSurface, zero-copy)")
        }

        captureFrame()
    }

    private func findFramebufferDescriptors(io: NSObject) throws -> [NSObject] {
        guard let ports = io.value(forKey: "deviceIOPorts") as? [NSObject] else {
            throw makeError(4, "Failed to get IO ports")
        }

        let pidSel = NSSelectorFromString("portIdentifier")
        let descSel = NSSelectorFromString("descriptor")
        let surfSel = NSSelectorFromString("framebufferSurface")

        var candidates: [NSObject] = []
        for port in ports {
            guard port.responds(to: pidSel),
                  let pid = port.perform(pidSel)?.takeUnretainedValue(),
                  "\(pid)" == "com.apple.framebuffer.display",
                  port.responds(to: descSel),
                  let desc = port.perform(descSel)?.takeUnretainedValue() as? NSObject,
                  desc.responds(to: surfSel)
            else { continue }
            candidates.append(desc)
        }

        if candidates.isEmpty {
            throw makeError(5, "No framebuffer display descriptor found")
        }
        return candidates
    }

    private func surface(for descriptor: NSObject) -> IOSurface? {
        let key = ObjectIdentifier(descriptor)
        if let surface = framebufferSurfaces[key] {
            return surface
        }

        let surfaceSelector = NSSelectorFromString("framebufferSurface")
        guard let surfaceObject = descriptor.perform(surfaceSelector)?.takeUnretainedValue() else {
            return nil
        }
        let surface = unsafeBitCast(surfaceObject, to: IOSurface.self)
        framebufferSurfaces[key] = surface
        return surface
    }

    /// Fixed feeds select only their panel. Main capture prefers the
    /// authoritative active panel and retains its legacy largest-area fallback.
    private func pickBestSurface() -> (key: ObjectIdentifier, surface: IOSurface)? {
        let surfaces = descriptors.compactMap { descriptor -> (key: ObjectIdentifier, surface: IOSurface)? in
            guard let surface = surface(for: descriptor) else { return nil }
            return (ObjectIdentifier(descriptor), surface)
        }
        let candidates = surfaces.map { key, surface in
            FramebufferSurfaceCandidate(
                screenID: screenMetadata[key]?.screenID,
                area: IOSurfaceGetWidth(surface) * IOSurfaceGetHeight(surface)
            )
        }
        guard let index = FramebufferSelectionPolicy.preferredIndex(
            in: candidates, activeScreenID: authoritativeDisplay?.screenID,
            fixedScreenID: fixedScreenID
        ) else { return nil }
        return surfaces[index]
    }

    private func startDisplayInfoUpdates() {
        displayInfoTask?.cancel()
        displayInfoTask = Task { [weak self] in
            while !Task.isCancelled {
                do {
                    try await Task.sleep(for: .milliseconds(250))
                    guard !Task.isCancelled else { return }
                    await self?.requestDisplayInfoRefresh()
                } catch {
                    return
                }
            }
        }
    }

    private func requestDisplayInfoRefresh() {
        guard fixedScreenID == nil, displayConfigurationReady, let deviceUDID,
              Set(screenMetadata.values.filter { $0.screenType == 0 }.map(\.screenID)).count == 2 else { return }
        displayRefreshRequested = true
        guard displayRefreshTask == nil else { return }
        let generation = captureGeneration
        displayRefreshTask = Task { [weak self] in
            await self?.refreshDisplayInfo(udid: deviceUDID, generation: generation)
        }
    }

    private func refreshDisplayInfo(udid: String, generation: UInt64) async {
        defer { if generation == captureGeneration { displayRefreshTask = nil } }
        while displayRefreshRequested, generation == captureGeneration, !Task.isCancelled {
            displayRefreshRequested = false
            if let displays = try? await CoreDeviceDisplayInfo.read(udid: udid) {
                guard generation == captureGeneration, !Task.isCancelled else { return }
                updateDisplayInfo(displays)
            }
            // Transient failures retain the last known panel until another
            // notification or fallback poll retries the read.
        }
    }

    func subscribeScreenChanges(_ callback: @escaping @Sendable () -> Void) -> @Sendable () async -> Void {
        let id = UUID()
        screenObservers[id] = callback
        return { [weak self] in await self?.removeScreenObserver(id) }
    }

    private func removeScreenObserver(_ id: UUID) { screenObservers.removeValue(forKey: id) }

    private func updateDisplayInfo(_ displays: [CoreDeviceDisplayState]) {
        let integratedIDs = Set(screenMetadata.values.filter { $0.screenType == 0 }.map(\.screenID))
        guard let active = displays.first(where: { $0.isActive && integratedIDs.contains($0.screenID) }),
              active != authoritativeDisplay else { return }
        authoritativeDisplay = active
        invalidatePick()
        captureFrame(force: true)
    }

    /// The winning descriptor for as long as it stays valid. Re-ranking every frame costs a size
    /// query per descriptor, and a callback that clears a descriptor's cached surface sends the
    /// next rank back through the private surface API, which is slowest while the compositor is
    /// mid-swap.
    private func currentSurface() -> (key: ObjectIdentifier, surface: IOSurface)? {
        let now = ContinuousClock.now
        if let last = lastPickAttempt, (now - last) < Self.pickRevalidateInterval,
           let key = bestSurfaceKey, let surface = framebufferSurfaces[key] {
            return (key, surface)
        }
        lastPickAttempt = now
        let best = pickBestSurface()
        bestSurfaceKey = best?.key
        return best
    }

    private func invalidatePick() {
        bestSurfaceKey = nil
        lastPickAttempt = nil
    }

    // MARK: - Frame callbacks

    private func registerFrameCallbacks(desc: AnyObject) throws {
        let regSel = #selector(FramebufferDescriptor.registerScreenCallbacks)
        guard let descriptor = desc as? NSObject, descriptor.responds(to: regSel) else {
            throw makeError(8, "Descriptor doesn't support registerScreenCallbacks")
        }

        let uuid = UUID()
        let key = ObjectIdentifier(descriptor)
        callbackUUIDs[key] = uuid

        let frameCallback: ScreenFrameCallback = { [weak self] in
            guard let self else { return }
            self.assumeIsolated { $0.captureFrame() }
        }
        let surfacesChangedCallback: ScreenSurfacesChangedCallback = {
            [weak self, weak descriptor] unmasked, masked in
            guard let self, let descriptor else { return }
            self.assumeIsolated {
                $0.updateSurface(for: descriptor, unmasked: unmasked, masked: masked)
                $0.captureFrame()
            }
        }
        let propertiesChangedCallback: ScreenPropertiesChangedCallback = { [weak self, weak descriptor] properties in
            guard let self, let descriptor else { return }
            self.assumeIsolated {
                let key = ObjectIdentifier(descriptor)
                if let properties = properties as? NSObject {
                    $0.screenMetadata[key] = SimDisplayMetadata.read(properties: properties)
                } else {
                    $0.screenMetadata[key] = SimDisplayMetadata.read(from: descriptor)
                }
                $0.invalidatePick()
                $0.captureFrame(force: true)
                // Older SimScreen properties can lag Duo's active flag; query
                // CoreDevice immediately instead of waiting for the idle poll.
                $0.requestDisplayInfoRefresh()
            }
        }
        callbackBlocks[key] = ScreenCallbackBlocks(
            frame: frameCallback,
            surfacesChanged: surfacesChangedCallback,
            propertiesChanged: propertiesChangedCallback
        )

        desc.registerScreenCallbacks(
            uuid: uuid,
            callbackQueue: queue,
            frameCallback: frameCallback,
            surfacesChangedCallback: surfacesChangedCallback,
            propertiesChangedCallback: propertiesChangedCallback
        )
    }

    /// A DispatchSourceTimer on the actor's own queue rather than `Task.sleep`, whose leeway
    /// held the poll to 48Hz on bare metal even with nothing else running. `.strict` opts out
    /// of coalescing, which is what the frame pump needed on virtualized hosts.
    private func startSurfacePoller() {
        let intervalNs = UInt64(SimulatorCapturePollPolicy.intervalNanoseconds)
        let interval = DispatchTimeInterval.nanoseconds(Int(intervalNs))
        let first = DispatchTime.now() + interval
        pollGrid = PollDeadlineGrid(
            firstDeadlineNanoseconds: first.uptimeNanoseconds, intervalNanoseconds: intervalNs
        )
        let timer = DispatchSource.makeTimerSource(flags: .strict, queue: queue)
        timer.schedule(deadline: first, repeating: interval, leeway: .nanoseconds(0))
        timer.setEventHandler { [weak self] in
            guard let self else { return }
            self.assumeIsolated {
                $0.recordPollWake()
                $0.onSurfacePollTick()
            }
        }
        timer.resume()
        surfacePollTimer = timer
    }

    /// Measured against the deadline the timer was scheduled for, not against the previous
    /// wake. The handler runs capture on this same serial queue, so wake-to-wake would charge
    /// our own capture cost to the host and hide the thing this number exists to find.
    private func recordPollWake() {
        // Both counters advance together or not at all: the mean is their ratio.
        guard let lateNs = pollGrid?.wake(atNanoseconds: DispatchTime.now().uptimeNanoseconds)
        else { return }
        pollTicks += 1
        pollLateSumNs += lateNs
    }

    private func onSurfacePollTick() {
        let now = ContinuousClock.now
        let idleRefreshDue = (now - self.lastCaptureTime) >= Self.idleInterval
        self.captureFrame(force: idleRefreshDue)
        // Self-heal: if we've never captured a frame, the cached descriptor
        // is likely stale. Re-wire the pipeline periodically
        // until frames start flowing.
        if self.frameCount == 0, (now - self.lastRewireAttempt) >= Self.rewireInterval {
            self.lastRewireAttempt = now
            do {
                try self.wireUpFramebuffer()
            } catch {
                // Swallow — we'll try again on a later tick.
            }
        }
    }

    // MARK: - Frame capture

    private func updateSurface(for descriptor: NSObject, unmasked: IOSurface?, masked: IOSurface?) {
        let key = ObjectIdentifier(descriptor)
        invalidatePick()
        guard let surface = unmasked ?? masked else {
            framebufferSurfaces.removeValue(forKey: key)
            lastSeeds.removeValue(forKey: key)
            return
        }
        framebufferSurfaces[key] = surface
    }

    func pickTimings() -> (count: UInt64, sumNs: UInt64, maxNs: UInt64) {
        (count: pickCount, sumNs: pickSumNs, maxNs: pickMaxNs)
    }

    func frameCounts() -> (screen: UInt64, idle: UInt64) {
        (screen: screenFrameCount, idle: idleFrameCount)
    }

    private func captureFrame(force: Bool = false) {
        guard displayConfigurationReady else { return }
        let entryNs = DispatchTime.now().uptimeNanoseconds
        if captureLastEntryNs > 0 {
            let gapNs = entryNs - captureLastEntryNs
            captureAttempts += 1
            captureGapSumNs += gapNs
            if gapNs > Self.stallThresholdNanoseconds {
                captureStalls += 1
                captureStallSumNs += gapNs
            }
        }
        captureLastEntryNs = entryNs
        let pickStartNs = DispatchTime.now().uptimeNanoseconds
        let picked = currentSurface()
        let pickNs = DispatchTime.now().uptimeNanoseconds - pickStartNs
        pickCount += 1
        pickSumNs += pickNs
        if pickNs > pickMaxNs { pickMaxNs = pickNs }
        guard let (key, surface) = picked else { return }
        let display = screenMetadata[key]?.applying(authoritativeDisplay)
        let displayChanged = capturedDisplay != display

        // Seed-skip: when the simulator's framebuffer content hasn't changed,
        // don't spend cycles re-encoding the same pixels back-to-back from the
        // frame-callback path. BUT: we must still re-emit at the idle floor
        // (~5 fps) so that downstream consumers keep seeing a live stream —
        // see the `idleInterval` doc-comment for why that matters.
        let seed = IOSurfaceGetSeed(surface)
        let seedChanged = lastSeeds[key] != seed
        if frameCount > 0, !seedChanged, !displayChanged, !force { return }
        lastSeeds[key] = seed

        let w = IOSurfaceGetWidth(surface)
        let h = IOSurfaceGetHeight(surface)
        guard w > 0, h > 0 else { return }

        // Keep the orientation and input destination tied to the framebuffer
        // actually being streamed, including non-default integrated displays.
        capturedDisplay = display

        let dimensionsChanged = capturedWidth != w || capturedHeight != h
        if dimensionsChanged {
            capturedWidth = w
            capturedHeight = h
            print("[capture] Surface size changed: \(w)x\(h)")
        }
        if displayChanged || dimensionsChanged {
            for notify in screenObservers.values { notify() }
        }

        var pixelBuffer: Unmanaged<CVPixelBuffer>?
        let status = CVPixelBufferCreateWithIOSurface(
            kCFAllocatorDefault, surface,
            [kCVPixelBufferPixelFormatTypeKey: kCVPixelFormatType_32BGRA] as CFDictionary,
            &pixelBuffer
        )
        guard status == kCVReturnSuccess, let pb = pixelBuffer?.takeRetainedValue() else { return }

        lastCaptureTime = .now
        frameCount += 1
        if force { idleFrameCount += 1 } else { screenFrameCount += 1 }
        // WebRTC consumes this timestamp as the capture presentation time. A
        // frame counter makes sparse/idle frames look 1/60s apart even when
        // they were captured hundreds of milliseconds apart, which confuses
        // the receiver jitter buffer. Host time is monotonic and reflects the
        // actual capture cadence.
        let timestamp = CMClockGetTime(CMClockGetHostTimeClock())
        guard let copy = photocopier.copy(pb, maxDimension: snapshotMaxDimension) else { return }
        onFrame?(copy, timestamp)
    }

    /// Snapshotting straight to the delivery size avoids moving the whole framebuffer through
    /// the GPU only to shrink it a step later.
    func setSnapshotMaxDimension(_ value: Int) {
        snapshotMaxDimension = max(0, value)
    }

    func captureTimings() -> (
        attempts: UInt64, gapSumNs: UInt64, stalls: UInt64, stallSumNs: UInt64, cpuFallbacks: UInt64
    ) {
        (
            attempts: captureAttempts,
            gapSumNs: captureGapSumNs,
            stalls: captureStalls,
            stallSumNs: captureStallSumNs,
            cpuFallbacks: photocopier.cpuFallbacks
        )
    }

    func pollTimings() -> (ticks: UInt64, lateSumNs: UInt64) {
        (ticks: pollTicks, lateSumNs: pollLateSumNs)
    }

    func getScreenSize() -> CapturedScreenInfo? {
        guard capturedWidth > 0, capturedHeight > 0 else { return nil }
        return CapturedScreenInfo(width: capturedWidth, height: capturedHeight, display: capturedDisplay)
    }

    deinit {
        surfacePollTimer?.cancel()
        displayInfoTask?.cancel()
        displayRefreshTask?.cancel()
    }

    func stop() {
        captureGeneration &+= 1
        displayInfoTask?.cancel()
        displayInfoTask = nil
        displayRefreshTask?.cancel()
        displayRefreshTask = nil
        displayRefreshRequested = false
        screenObservers.removeAll()
        deviceUDID = nil
        authoritativeDisplay = nil
        displayConfigurationReady = false
        surfacePollTimer?.cancel()
        surfacePollTimer = nil
        pollGrid = nil
        // A capture that is started again must not book the time it spent stopped as a stall.
        captureLastEntryNs = 0

        unregisterCallbacks()
        descriptors.removeAll()
        lastSeeds.removeAll()
        framebufferSurfaces.removeAll()
        screenMetadata.removeAll()
        capturedDisplay = nil
        invalidatePick()
        photocopier.reset()
        ioClient = nil
    }

    private func unregisterCallbacks() {
        let unregSel = NSSelectorFromString("unregisterScreenCallbacksWithUUID:")
        for desc in descriptors {
            if let uuid = callbackUUIDs[ObjectIdentifier(desc)],
               desc.responds(to: unregSel) {
                desc.perform(unregSel, with: uuid)
            }
        }
        callbackUUIDs.removeAll()
        callbackBlocks.removeAll()
    }

    // MARK: - Helpers

    private func makeError(_ code: Int, _ msg: String) -> NSError {
        NSError(domain: "FrameCapture", code: code,
                userInfo: [NSLocalizedDescriptionKey: msg])
    }

    static func findSimDevice(udid: String) -> NSObject? {
        guard let contextClass = NSClassFromString("SimServiceContext") as? NSObject.Type else { return nil }
        let developerDir = Xcode.developerDir()
        let sharedSel = NSSelectorFromString("sharedServiceContextForDeveloperDir:error:")
        guard let context = contextClass.perform(sharedSel, with: developerDir, with: nil)?
                .takeUnretainedValue() as? NSObject else { return nil }
        let deviceSetSel = NSSelectorFromString("defaultDeviceSetWithError:")
        guard let deviceSet = context.perform(deviceSetSel, with: nil)?
                .takeUnretainedValue() as? NSObject else { return nil }
        guard let devices = deviceSet.value(forKey: "devices") as? [NSObject] else { return nil }
        return devices.first(where: {
            ($0.value(forKey: "UDID") as? NSUUID)?.uuidString == udid
        })
    }
}

@objc protocol FramebufferDescriptor {
    @objc(registerScreenCallbacksWithUUID:callbackQueue:frameCallback:surfacesChangedCallback:propertiesChangedCallback:)
    func registerScreenCallbacks(
        uuid: UUID,
        callbackQueue: DispatchQueue,
        frameCallback: @escaping ScreenFrameCallback,
        surfacesChangedCallback: @escaping ScreenSurfacesChangedCallback,
        propertiesChangedCallback: @escaping ScreenPropertiesChangedCallback
    )
}
