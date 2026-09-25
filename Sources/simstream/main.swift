import Foundation
import IOSurface
import SimBridge

struct SimStreamError: Error, CustomStringConvertible {
    let description: String
    init(_ description: String) { self.description = description }
}

enum Clock {
    /// Monotonic milliseconds. Clients map this onto their own clock via ping/pong.
    static func ms() -> Double { Double(DispatchTime.now().uptimeNanoseconds) / 1_000_000 }
}

func log(_ message: String) {
    print("[simstream] \(message)")
}

struct Options {
    var udid: String?
    var port: UInt16 = 8765
    var scale = 1.0
    var fps = 60
    var bitrateMbps = 40.0
    var refineFrames = 12
    var constantFrameRate = true
    var measureQuality = false

    static let usage = """
    usage: simstream [--udid <UDID>] [--port 8765] [--scale 1] [--fps 60] [--bitrate 40] [--refine 12] [--vfr]

      --udid         simulator to stream (default: first booted device)
      --port         HTTP port for the web client and the stream (WebSocket on /stream)
      --scale        output resolution relative to the device framebuffer
      --fps          capture/encode frame-rate cap
      --bitrate      max bitrate per viewer in Mbps (each viewer adapts to its own link)
      --vfr          variable frame rate: only encode changes (plus --refine frames) instead of
                     repeating the last frame at a constant --fps while viewers are watching
      --refine       with --vfr, extra frames encoded after motion stops to sharpen the settled image
      --quality      decode every frame server-side and log luma PSNR vs the source (diagnostic;
                     compare runs relative to each other)
    """

    static func parse(_ args: [String]) -> Options {
        var options = Options()
        var it = args.dropFirst().makeIterator()
        while let arg = it.next() {
            switch arg {
            case "--udid": options.udid = it.next()
            case "--port": options.port = it.next().flatMap(UInt16.init) ?? options.port
            case "--scale": options.scale = it.next().flatMap(Double.init) ?? options.scale
            case "--fps": options.fps = it.next().flatMap(Int.init) ?? options.fps
            case "--bitrate": options.bitrateMbps = it.next().flatMap(Double.init) ?? options.bitrateMbps
            case "--quality": options.measureQuality = true
            case "--vfr": options.constantFrameRate = false
            case "--refine": options.refineFrames = it.next().flatMap(Int.init) ?? options.refineFrames
            case "-h", "--help": print(usage); exit(0)
            default: print("unknown argument \(arg)\n\n\(usage)"); exit(2)
            }
        }
        return options
    }
}

func developerDir() -> String {
    if let env = ProcessInfo.processInfo.environment["DEVELOPER_DIR"] { return env }
    let process = Process()
    process.executableURL = URL(fileURLWithPath: "/usr/bin/xcode-select")
    process.arguments = ["-p"]
    let pipe = Pipe()
    process.standardOutput = pipe
    try? process.run()
    process.waitUntilExit()
    let path = String(data: pipe.fileHandleForReading.readDataToEndOfFile(), encoding: .utf8)?
        .trimmingCharacters(in: .whitespacesAndNewlines)
    return path?.isEmpty == false ? path! : "/Applications/Xcode.app/Contents/Developer"
}

func even(_ value: Double) -> Int { max(2, Int(value) & ~1) }

// MARK: - Main

setvbuf(stdout, nil, _IOLBF, 0)
let options = Options.parse(CommandLine.arguments)

do {
    let sim = try SBSimulator.attach(developerDir: developerDir(), udid: options.udid)
    guard let framebuffer = sim.framebuffer() else { throw SimStreamError("device has no framebuffer yet") }
    let sourceWidth = IOSurfaceGetWidth(framebuffer), sourceHeight = IOSurfaceGetHeight(framebuffer)
    let width = even(Double(sourceWidth) * options.scale), height = even(Double(sourceHeight) * options.scale)
    log("attached to \(sim.name) (\(sim.runtimeName)) \(sim.udid) — framebuffer \(sourceWidth)×\(sourceHeight)")

    let maxBitrate = Int(options.bitrateMbps * 1_000_000)
    let pump = try FramePump(sim: sim, width: width, height: height, fps: options.fps,
                             refineFrames: options.refineFrames, constantFrameRate: options.constantFrameRate)

    guard let webRoot = Bundle.module.url(forResource: "Web", withExtension: nil) else {
        throw SimStreamError("missing Web resources")
    }
    let stream = try StreamServer(port: options.port, webRoot: webRoot)

    // Viewers, keyed by connection; only touched on the server queue.
    var viewers: [UUID: Viewer] = [:]
    var nextViewerID = 1
    func updateWatching() {
        pump.setWatching(viewers.values.contains { !$0.paused })
    }

    // Capture once, encode per viewer.
    pump.onFrame = { pixelBuffer, captureMs, inputSeq in
        stream.queue.async {
            for viewer in viewers.values {
                viewer.offer(pixelBuffer, captureMs: captureMs, inputSeq: inputSeq)
            }
        }
    }

    stream.onConnect = { client in
        do {
            let viewer = try Viewer(id: nextViewerID, client: client, server: stream, width: width, height: height,
                                    fps: options.fps, maxBitrate: maxBitrate, measureQuality: options.measureQuality)
            nextViewerID += 1
            viewers[client.id] = viewer
            log("viewer \(viewer.id) connected (\(viewers.count) total)")
            updateWatching()
            pump.requestFrame()
        } catch {
            log("error: could not create an encoder for a new viewer: \(error)")
            client.connection.cancel()
        }
    }
    stream.onDisconnect = { client in
        guard let viewer = viewers.removeValue(forKey: client.id) else { return }
        log("viewer \(viewer.id) disconnected (\(viewers.count) total)")
        updateWatching()
    }
    stream.onMessage = { client, message in
        let viewer = viewers[client.id]
        switch message["t"] as? String {
        case "ack":
            if let seq = (message["seq"] as? NSNumber)?.uint32Value { viewer?.ack(seq) }
        case "keyframe":
            viewer?.requestKeyframe()
            pump.requestFrame()
        case "pause":
            viewer?.pause()
            updateWatching()
            if let viewer { log("viewer \(viewer.id) paused (page hidden)") }
        case "resume":
            viewer?.resume()
            updateWatching()
            pump.requestFrame()
            if let viewer { log("viewer \(viewer.id) resumed") }
        case "touch":
            guard let x = message["x"] as? Double, let y = message["y"] as? Double else { return }
            let phase: SBTouchPhase = switch message["p"] as? String {
            case "down": .down
            case "up": .up
            default: .move
            }
            let edge = (message["edge"] as? NSNumber)?.uint32Value ?? 0
            if sim.sendTouch(phase, x: x, y: y, edge: edge), let seq = (message["seq"] as? NSNumber)?.uint32Value {
                pump.noteInput(seq)
            }
        case "key":
            guard let usage = (message["usage"] as? NSNumber)?.uint32Value else { return }
            sim.sendKey(usage, down: message["down"] as? Bool ?? false)
        case "button":
            let button: SBButton = switch message["b"] as? String {
            case "lock": .lock
            case "siri": .siri
            default: .home
            }
            sim.send(button, down: message["down"] as? Bool ?? false)
        case "ping":
            stream.sendJSON(["t": "pong", "ts": message["ts"] ?? 0, "server": Clock.ms()], to: client)
        default:
            break
        }
    }

    pump.start()

    // Bitrate control, ten times a second per viewer.
    let controlTimer = DispatchSource.makeTimerSource(queue: stream.queue)
    controlTimer.schedule(deadline: .now() + 0.1, repeating: 0.1)
    controlTimer.setEventHandler {
        for viewer in viewers.values { viewer.tick() }
    }
    controlTimer.resume()

    // Once a second: log per-viewer stats and push them to each viewer's HUD.
    var lastCaptured = 0
    let statsTimer = DispatchSource.makeTimerSource(queue: stream.queue)
    statsTimer.schedule(deadline: .now() + 1, repeating: 1)
    statsTimer.setEventHandler {
        let captured = pump.capturedFrames
        let c = pump.takeCadence()
        if c.captured > 0 {
            log("source: \(c.captured) new frames, \(c.missed) missed, \(c.damage) damage callbacks")
        }
        for viewer in viewers.values.sorted(by: { $0.id < $1.id }) {
            let s = viewer.takeStats()
            let cc = viewer.congestion
            stream.sendJSON(["t": "stats", "captureFps": captured - lastCaptured, "bitrate": cc.bitrate], to: viewer.client)
            guard s.frames > 0 else { continue }
            var line = String(format: "viewer %d: %d fps  %.2f Mbps (target %.1f)  avg %.1f KB  max %.1f KB  key %d  encode %.1f ms  queue %.0f ms over %.0f ms",
                              viewer.id, s.frames, Double(s.bytes * 8) / 1e6, Double(cc.bitrate) / 1e6,
                              Double(s.bytes) / Double(s.frames) / 1024, Double(s.maxBytes) / 1024, s.keyframes,
                              s.encodeMs / Double(s.frames), cc.queueMs, cc.baselineOrZero)
            line += "  \(viewer.resolution.width)×\(viewer.resolution.height)"
            if s.dropped > 0 { line += "  dropped \(s.dropped) (encoder rate control)" }
            let skipped = viewer.takeSkipped()
            if skipped > 0 { line += "  skipped \(skipped) (encoder behind)" }
            if s.psnrCount > 0 {
                line += String(format: "  psnr avg %.1f min %.1f dB", s.psnrSum / Double(s.psnrCount), s.psnrMin)
            }
            log(line)
        }
        lastCaptured = captured
    }
    statsTimer.resume()

    log("encoding \(width)×\(height) H.264 @ ≤\(options.fps) fps per viewer, ≤\(options.bitrateMbps) Mbps each")
    log("open http://localhost:\(options.port)")
    log("other devices need HTTPS for WebCodecs — e.g. `tailscale serve --bg --https=8449 http://127.0.0.1:\(options.port)`")
    withExtendedLifetime((stream, controlTimer, statsTimer)) { dispatchMain() }
} catch {
    log("error: \(error)")
    exit(1)
}
