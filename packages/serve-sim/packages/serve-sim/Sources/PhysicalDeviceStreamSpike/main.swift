import CoreGraphics
import CoreMedia
import CoreVideo
import Foundation
import ImageIO
import StreamingPolicy
import UniformTypeIdentifiers
import VideoToolbox

final class FrameCounter: @unchecked Sendable {
    private let lock = NSLock()
    private var count = 0
    private var first: TimeInterval?
    private var last: TimeInterval?
    private var size = (width: 0, height: 0)
    private var saved: CVPixelBuffer?
    let began = ProcessInfo.processInfo.systemUptime

    func record(_ frame: CVPixelBuffer) {
        let now = ProcessInfo.processInfo.systemUptime
        lock.lock()
        count += 1
        if first == nil { first = now }
        last = now
        size = (CVPixelBufferGetWidth(frame), CVPixelBufferGetHeight(frame))
        if saved == nil, let first, now - first >= 1 { saved = frame }
        lock.unlock()
    }

    func snapshot() -> (count: Int, first: TimeInterval?, last: TimeInterval?, size: (width: Int, height: Int), saved: CVPixelBuffer?) {
        lock.lock()
        defer { lock.unlock() }
        return (count, first, last, size, saved)
    }
}

func writePNG(_ frame: CVPixelBuffer, to path: String) -> Bool {
    var image: CGImage?
    guard VTCreateCGImageFromCVPixelBuffer(frame, options: nil, imageOut: &image) == noErr, let image,
          let destination = CGImageDestinationCreateWithURL(URL(fileURLWithPath: path) as CFURL, UTType.png.identifier as CFString, 1, nil)
    else { return false }
    CGImageDestinationAddImage(destination, image, nil)
    return CGImageDestinationFinalize(destination)
}

func log(_ message: String) {
    let stamp = String(format: "%.3f", ProcessInfo.processInfo.systemUptime)
    FileHandle.standardError.write(Data("[\(stamp)] \(message)\n".utf8))
}

func seconds(_ value: Double) async {
    try? await Task.sleep(nanoseconds: UInt64(value * 1_000_000_000))
}

final class LumaWatch: @unchecked Sendable {
    private let lock = NSLock()
    private var latest: [UInt8] = []
    private var latestSize = Dimensions(width: 0, height: 0)
    private var baseline: [UInt8]?
    private var changedAt: TimeInterval?
    private var frames: [(time: TimeInterval, idle: Bool)] = []

    func record(_ pixels: CVPixelBuffer) {
        let signature = Self.signature(pixels)
        let now = ProcessInfo.processInfo.systemUptime
        lock.withLock {
            latest = signature
            latestSize = pixels.dimensions
            frames.append((now, false))
            if let baseline, changedAt == nil, Self.changedFraction(baseline, signature) > 0.02 { changedAt = now }
        }
    }

    func arm() { lock.withLock { baseline = latest; changedAt = nil } }
    var change: TimeInterval? { lock.withLock { changedAt } }
    var size: Dimensions { lock.withLock { latestSize } }
    func frameTimes() -> [TimeInterval] { lock.withLock { frames.map(\.time) } }

    static func signature(_ pixels: CVPixelBuffer) -> [UInt8] {
        CVPixelBufferLockBaseAddress(pixels, .readOnly)
        defer { CVPixelBufferUnlockBaseAddress(pixels, .readOnly) }
        let planar = CVPixelBufferIsPlanar(pixels)
        guard let base = (planar ? CVPixelBufferGetBaseAddressOfPlane(pixels, 0) : CVPixelBufferGetBaseAddress(pixels))?
            .assumingMemoryBound(to: UInt8.self) else { return [] }
        let stride = planar ? CVPixelBufferGetBytesPerRowOfPlane(pixels, 0) : CVPixelBufferGetBytesPerRow(pixels)
        let width = CVPixelBufferGetWidth(pixels), height = CVPixelBufferGetHeight(pixels)
        var samples: [UInt8] = []
        for row in 0..<96 {
            for column in 0..<48 {
                let x = column * width / 48, y = row * height / 96
                samples.append(planar ? base[y * stride + x] : base[y * stride + x * 4 + 1])
            }
        }
        return samples
    }

    static func changedFraction(_ a: [UInt8], _ b: [UInt8]) -> Double {
        guard a.count == b.count, !a.isEmpty else { return 1 }
        let changed = zip(a, b).filter { abs(Int($0) - Int($1)) > 24 }.count
        return Double(changed) / Double(a.count)
    }
}

func pixelDifference(_ a: CVPixelBuffer, _ b: CVPixelBuffer) -> Double {
    guard a.dimensions == b.dimensions else { return 1 }
    CVPixelBufferLockBaseAddress(a, .readOnly)
    CVPixelBufferLockBaseAddress(b, .readOnly)
    defer {
        CVPixelBufferUnlockBaseAddress(a, .readOnly)
        CVPixelBufferUnlockBaseAddress(b, .readOnly)
    }
    let pa = CVPixelBufferGetBaseAddress(a)!.assumingMemoryBound(to: UInt8.self)
    let pb = CVPixelBufferGetBaseAddress(b)!.assumingMemoryBound(to: UInt8.self)
    let sa = CVPixelBufferGetBytesPerRow(a), sb = CVPixelBufferGetBytesPerRow(b)
    var changed = 0, total = 0
    for y in Swift.stride(from: 0, to: a.dimensions.height, by: 2) {
        for x in Swift.stride(from: 0, to: a.dimensions.width, by: 2) {
            let ia = y * sa + x * 4, ib = y * sb + x * 4
            let delta = abs(Int(pa[ia]) - Int(pb[ib])) + abs(Int(pa[ia + 1]) - Int(pb[ib + 1])) + abs(Int(pa[ia + 2]) - Int(pb[ib + 2]))
            if delta > 48 { changed += 1 }
            total += 1
        }
    }
    return Double(changed) / Double(total)
}

final class Validation {
    let udid: String
    let output: String
    let source = PhysicalScreenSource()
    let injector = HIDInjector()
    let watch = LumaWatch()
    var shots: [String: CVPixelBuffer] = [:]
    var latencies: [String: Double] = [:]

    init(udid: String, output: String) {
        self.udid = udid
        self.output = output
    }

    func shoot(_ name: String) async throws {
        let shot = try await source.screenshotPixels(screenID: try await source.activeScreenID()).pixels
        shots[name] = shot
        let path = "\(output)/\(name).png"
        log("\(name): \(shot.dimensions.width)x\(shot.dimensions.height) \(writePNG(shot, to: path) ? path : "not saved")")
    }

    func difference(_ a: String, _ b: String) -> Double {
        guard let first = shots[a], let second = shots[b] else { return .nan }
        let value = pixelDifference(first, second)
        log(String(format: "difference %@ → %@: %.1f%% of pixels", a, b, value * 100))
        return value
    }

    func swipe(_ name: String, from: (Double, Double), to: (Double, Double), edge: UInt32, steps: Int = 12) async {
        watch.arm()
        let began = ProcessInfo.processInfo.systemUptime
        await injector.sendTouch(type: "begin", x: from.0, y: from.1, screenWidth: 0, screenHeight: 0, edge: edge)
        for step in 1...steps {
            await seconds(0.016)
            let t = Double(step) / Double(steps)
            await injector.sendTouch(type: "move", x: from.0 + (to.0 - from.0) * t, y: from.1 + (to.1 - from.1) * t,
                                     screenWidth: 0, screenHeight: 0, edge: edge)
        }
        await injector.sendTouch(type: "end", x: to.0, y: to.1, screenWidth: 0, screenHeight: 0, edge: edge)
        await settle(name, since: began)
    }

    func settle(_ name: String, since began: TimeInterval) async {
        let deadline = began + 3
        while watch.change == nil, ProcessInfo.processInfo.systemUptime < deadline { await seconds(0.005) }
        if let change = watch.change {
            latencies[name] = change - began
            log(String(format: "%@: first changed frame %.0f ms after the gesture began", name, (change - began) * 1000))
        } else {
            log("\(name): no visible change within 3 s")
        }
        await seconds(1.2)
    }

    func run() async throws {
        let began = ProcessInfo.processInfo.systemUptime
        try await source.start(deviceUDID: udid, screenID: nil, onFrame: { [watch] pixels, _, _, _ in
            watch.record(pixels)
        }, onEnd: { end in
            log("source ended: \(end.json())")
        })
        log(String(format: "PhysicalScreenSource.start returned after %.3f s with the first frame", ProcessInfo.processInfo.systemUptime - began))
        let screen = await source.getScreenSize()
        log("screen: \(screen.map { "\($0.width)x\($0.height) id \($0.display?.screenID ?? 0) \($0.display?.orientation ?? "?") \($0.display?.chromeIdentifier ?? "")" } ?? "none")")
        try await injector.setup(deviceUDID: udid, kind: .physical)
        await injector.setScreen(screenID: try await source.activeScreenID())
        let keyboard = await injector.supportsKeyboard()
        log("HID ready, keyboard \(keyboard ? "available" : "unavailable")")

        await seconds(1)
        try await shoot("01-home")
        await swipe("notification-center-open", from: (0.5, 0.0), to: (0.5, 0.65), edge: 2)
        try await shoot("02-notification-center")
        watch.arm()
        var mark = ProcessInfo.processInfo.systemUptime
        await injector.sendButton(button: "swipe_home", deviceUDID: udid)
        await settle("notification-center-close", since: mark)
        try await shoot("03-notification-center-closed")
        watch.arm()
        mark = ProcessInfo.processInfo.systemUptime
        await injector.sendButton(button: "home", deviceUDID: udid)
        await settle("home-swipe", since: mark)
        try await shoot("04-after-home-swipe")
        await swipe("spotlight-open", from: (0.5, 0.35), to: (0.5, 0.7), edge: 0)
        try await shoot("05-spotlight")
        watch.arm()
        mark = ProcessInfo.processInfo.systemUptime
        for usage: UInt32 in [0x04, 0x05, 0x06] {
            await injector.sendKey(type: "down", usage: usage)
            await seconds(0.04)
            await injector.sendKey(type: "up", usage: usage)
            await seconds(0.08)
        }
        await settle("typing-abc", since: mark)
        try await shoot("06-spotlight-abc")
        watch.arm()
        mark = ProcessInfo.processInfo.systemUptime
        await injector.sendButton(button: "swipe_home", deviceUDID: udid)
        await settle("spotlight-dismiss", since: mark)
        try await shoot("07-spotlight-dismissed")
        if await PhysicalScreenSource.liveOrientation(deviceUDID: udid, displayID: try await source.activeScreenID()) != "portrait" {
            log("warning: the phone does not report a portrait interface")
        }

        let streamed = ProcessInfo.processInfo.systemUptime - began
        let times = watch.frameTimes()
        let counts = await source.frameCounts()
        log(String(format: "streamed %.1f s: %d frames emitted (%d decoded, %d idle re-emissions), %.1f fps",
                   streamed, times.count, counts.screen, counts.idle, Double(times.count) / streamed))
        log(String(format: "NC open %.1f%%, NC closed vs home %.1f%%, home swipe vs home %.1f%%, spotlight %.1f%%, abc vs spotlight %.1f%%, dismissed vs home %.1f%%",
                   difference("01-home", "02-notification-center") * 100,
                   difference("01-home", "03-notification-center-closed") * 100,
                   difference("01-home", "04-after-home-swipe") * 100,
                   difference("01-home", "05-spotlight") * 100,
                   difference("05-spotlight", "06-spotlight-abc") * 100,
                   difference("01-home", "07-spotlight-dismissed") * 100))
        log("latencies: \(latencies.sorted { $0.key < $1.key }.map { "\($0.key)=\(Int($0.value * 1000)) ms" }.joined(separator: ", "))")
    }

    func rotation() async throws {
        log("rotating to landscape")
        try devicectl(["device", "orientation", "set", "--device", udid, "landscapeLeft"])
        await seconds(2.5)
        let size = watch.size
        let orientation = await PhysicalScreenSource.liveOrientation(deviceUDID: udid, displayID: try await source.activeScreenID())
        let screen = await source.getScreenSize()
        log("after landscapeLeft: stream frame \(size.width)x\(size.height), interface \(orientation ?? "unknown"), screen \(screen.map { "\($0.width)x\($0.height) \($0.display?.orientation ?? "?")" } ?? "none")")
        try await shoot("08-landscape")
        if size.width > size.height {
            await swipe("landscape-notification-center-open", from: (0.5, 0.0), to: (0.5, 0.7), edge: 2)
            try await shoot("09-landscape-notification-center")
            _ = difference("08-landscape", "09-landscape-notification-center")
            watch.arm()
            let mark = ProcessInfo.processInfo.systemUptime
            await injector.sendButton(button: "swipe_home", deviceUDID: udid)
            await settle("landscape-notification-center-close", since: mark)
            try await shoot("10-landscape-closed")
            _ = difference("08-landscape", "10-landscape-closed")
        } else {
            log("the interface stayed portrait; the landscape swipe was not run")
        }
        try devicectl(["device", "orientation", "set", "--device", udid, "portrait"])
        await seconds(2)
        log("restored portrait: stream frame \(watch.size.width)x\(watch.size.height)")
    }

    func devicectl(_ arguments: [String]) throws {
        let process = Process()
        process.executableURL = URL(fileURLWithPath: "/usr/bin/xcrun")
        process.arguments = ["devicectl"] + arguments + ["--quiet"]
        try process.run()
        process.waitUntilExit()
        log("devicectl \(arguments.joined(separator: " ")) → \(process.terminationStatus)")
    }

    func finish() async {
        let began = ProcessInfo.processInfo.systemUptime
        await source.stop(preservingObservers: false)
        log(String(format: "stopped the stream and released the assertion in %.3f s", ProcessInfo.processInfo.systemUptime - began))
    }
}

func recordRTP(udid: String, duration: Double, path: String) async throws {
    guard CoreDeviceMediaStreamCalls.available() else { throw CoreDeviceMediaStreamError("CoreDevice media stream symbols are unavailable") }
    let device = try await CoreDeviceBridge.shared.remoteDevice(udid: udid)
    let session = CoreDeviceMediaStreamSession(device: device, log: log)
    let lock = NSLock()
    var recording = Data("SSRTP1".utf8)
    var packets = 0
    var started: TimeInterval?
    let decoded = FrameCounter()
    session.onDatagram = { datagram in
        let now = ProcessInfo.processInfo.systemUptime
        lock.withLock {
            if started == nil { started = now }
            guard let started, now - started <= duration else { return }
            var offset = UInt32(((now - started) * 1000).rounded()).bigEndian
            var length = UInt16(datagram.count).bigEndian
            withUnsafeBytes(of: &offset) { recording.append(contentsOf: $0) }
            withUnsafeBytes(of: &length) { recording.append(contentsOf: $0) }
            recording.append(datagram)
            packets += 1
        }
    }
    try await session.start(onFrame: { decoded.record($0) }, onEnd: { log("ended: \($0)") })
    await seconds(duration + 1)
    await session.stop()
    let result = decoded.snapshot()
    try lock.withLock { try recording.write(to: URL(fileURLWithPath: path)) }
    log("recorded \(packets) packets (\(recording.count) bytes) to \(path); live decode \(result.count) frames \(result.size.width)x\(result.size.height)")
}

func spike(identifier: String, seconds duration: Double, framePath: String?) async throws {
    guard CoreDeviceMediaStreamCalls.available() else { throw CoreDeviceMediaStreamError("CoreDevice media stream symbols are unavailable") }
    let counter = FrameCounter()
    let device = try await CoreDeviceBridge.shared.remoteDevice(udid: identifier)
    let session = CoreDeviceMediaStreamSession(device: device, log: log)
    try await session.start(onFrame: { counter.record($0) }, onEnd: { log("ended: \($0)") })
    log("stream \(session.streamID.map(String.init) ?? "?") started: \(session.timings)")
    let deadline = ProcessInfo.processInfo.systemUptime + 25
    while counter.snapshot().first == nil, ProcessInfo.processInfo.systemUptime < deadline { await seconds(0.05) }
    guard let first = counter.snapshot().first else {
        await session.stop()
        throw CoreDeviceMediaStreamError("no frame within 25 s")
    }
    let startCount = counter.snapshot().count
    log(String(format: "first frame %.3f s after start", first - counter.began))
    await seconds(duration)
    let result = counter.snapshot()
    log(String(format: "frames in %.0f s window: %d (%.2f fps); frame %dx%d", duration, result.count - startCount,
               Double(result.count - startCount) / duration, result.size.width, result.size.height))
    if let framePath, let saved = result.saved {
        log(writePNG(saved, to: framePath) ? "saved frame to \(framePath)" : "could not save frame")
    }
    await session.stop()
}

@main
enum PhysicalDeviceStreamSpike {
    static func main() async {
        let arguments = Array(CommandLine.arguments.dropFirst())
        do {
            switch arguments.first {
            case "validate" where arguments.count >= 3:
                let validation = Validation(udid: arguments[1], output: arguments[2])
                try FileManager.default.createDirectory(atPath: arguments[2], withIntermediateDirectories: true)
                do {
                    try await validation.run()
                    if arguments.contains("--rotate") { try await validation.rotation() }
                } catch {
                    log("validation failed: \(error)")
                    await validation.finish()
                    exit(1)
                }
                await validation.finish()
            case "record-rtp" where arguments.count >= 4:
                try await recordRTP(udid: arguments[1], duration: Double(arguments[2]) ?? 3, path: arguments[3])
            case "support":
                log(await PhysicalDeviceHost.report(deviceUDID: arguments.count > 1 ? arguments[1] : nil).json())
            case "stream" where arguments.count >= 2:
                try await spike(identifier: arguments[1], seconds: arguments.count > 2 ? Double(arguments[2]) ?? 10 : 10,
                                framePath: arguments.count > 3 ? arguments[3] : nil)
            default:
                log("""
                usage: physical-device-stream-spike validate <udid> <output dir> [--rotate]
                       physical-device-stream-spike record-rtp <udid> <seconds> <fixture>
                       physical-device-stream-spike support [udid]
                       physical-device-stream-spike stream <udid> [seconds] [frame.png]
                """)
                exit(64)
            }
        } catch {
            log("error: \(error)")
            exit(1)
        }
        exit(0)
    }
}
