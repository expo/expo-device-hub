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
    private var onFrame: ((CVPixelBuffer, CMTime) -> Void)?
    private var frameCount: UInt64 = 0
    /// Counted by which path produced the frame, callback or idle deadline.
    private var screenFrameCount: UInt64 = 0
    private var idleFrameCount: UInt64 = 0
    private(set) var capturedWidth: Int = 0
    private(set) var capturedHeight: Int = 0
    private var surfacePollTask: Task<Void, Never>?
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
    private static let surfacePollInterval: ContinuousClock.Duration = .nanoseconds(
        SimulatorCapturePollPolicy.intervalNanoseconds
    )
    private static let rewireInterval: ContinuousClock.Duration = .seconds(1)

    private var descriptors: [NSObject] = []
    private var callbackUUIDs: [ObjectIdentifier: UUID] = [:]
    // Keep private-API callback blocks alive until their registrations are removed.
    private var callbackBlocks: [ObjectIdentifier: ScreenCallbackBlocks] = [:]
    private var framebufferSurfaces: [ObjectIdentifier: IOSurface] = [:]
    private var ioClient: NSObject?

    func start(deviceUDID: String, onFrame: @escaping @Sendable (CVPixelBuffer, CMTime) -> Void) throws {
        self.onFrame = onFrame

        SimFrameworks.load()
        guard let device = Self.findSimDevice(udid: deviceUDID) else {
            throw makeError(1, "Device \(deviceUDID) not found")
        }

        let state = device.value(forKey: "stateString") as? String ?? "unknown"
        guard state == "Booted" else {
            throw makeError(2, "Device not booted (state: \(state))")
        }

        guard let io = device.perform(NSSelectorFromString("io"))?.takeUnretainedValue() as? NSObject else {
            throw makeError(3, "Failed to get device IO")
        }
        self.ioClient = io

        try wireUpFramebuffer()
        startSurfacePoller()
        print("[capture] Frame callbacks registered + 60Hz IOSurface poll + 5fps idle floor")
    }

    /// Find all framebuffer display descriptors, register callbacks on each,
    /// and cache them. Safe to re-call if the cached descriptors become stale.
    ///
    /// The simulator exposes multiple `com.apple.framebuffer.display` ports
    /// (main screen + secondary planes/overlays). We can't reliably tell which
    /// one is the primary up-front, so we listen on all of them and let
    /// `captureFrame()` pick whichever currently has the largest live surface.
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
        descriptors = candidates

        // Registering screen callbacks is what causes SimulatorKit to wire the
        // display pipeline to our client and populate `framebufferSurface`.
        do {
            for desc in candidates {
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

    /// Return the live surface with the largest area.
    /// Secondary planes/overlays are typically smaller than the main screen.
    private func pickBestSurface() -> (key: ObjectIdentifier, surface: IOSurface)? {
        var best: (key: ObjectIdentifier, surface: IOSurface)?
        var bestArea: Int = 0
        for descriptor in descriptors {
            guard let surface = surface(for: descriptor) else { continue }
            let area = IOSurfaceGetWidth(surface) * IOSurfaceGetHeight(surface)
            if area > bestArea {
                best = (ObjectIdentifier(descriptor), surface)
                bestArea = area
            }
        }
        return best
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
        let propertiesChangedCallback: ScreenPropertiesChangedCallback = { _ in }
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

    private func startSurfacePoller() {
        self.surfacePollTask = Task { [weak self] in
            while !Task.isCancelled {
                try? await Task.sleep(for: Self.surfacePollInterval)
                guard let self else { return }
                await self.onSurfacePollTick()
            }
        }
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
        guard let surface = unmasked ?? masked else {
            framebufferSurfaces.removeValue(forKey: key)
            lastSeeds.removeValue(forKey: key)
            return
        }
        framebufferSurfaces[key] = surface
    }

    func frameCounts() -> (screen: UInt64, idle: UInt64) {
        (screen: screenFrameCount, idle: idleFrameCount)
    }

    private func captureFrame(force: Bool = false) {
        guard let (key, surface) = pickBestSurface() else { return }

        // Seed-skip: when the simulator's framebuffer content hasn't changed,
        // don't spend cycles re-encoding the same pixels back-to-back from the
        // frame-callback path. BUT: we must still re-emit at the idle floor
        // (~5 fps) so that downstream consumers keep seeing a live stream —
        // see the `idleInterval` doc-comment for why that matters.
        let seed = IOSurfaceGetSeed(surface)
        let seedChanged = lastSeeds[key] != seed
        if frameCount > 0, !seedChanged, !force { return }
        lastSeeds[key] = seed

        let w = IOSurfaceGetWidth(surface)
        let h = IOSurfaceGetHeight(surface)
        guard w > 0, h > 0 else { return }

        if capturedWidth != w || capturedHeight != h {
            capturedWidth = w
            capturedHeight = h
            print("[capture] Surface size changed: \(w)x\(h)")
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
        guard let copy = photocopier.copy(pb) else { return }
        onFrame?(copy, timestamp)
    }

    func getScreenSize() -> (width: Int, height: Int)? {
        guard capturedWidth > 0, capturedHeight > 0 else { return nil }
        return (capturedWidth, capturedHeight)
    }

    func stop() {
        surfacePollTask?.cancel()
        surfacePollTask = nil

        unregisterCallbacks()
        descriptors.removeAll()
        lastSeeds.removeAll()
        framebufferSurfaces.removeAll()
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
