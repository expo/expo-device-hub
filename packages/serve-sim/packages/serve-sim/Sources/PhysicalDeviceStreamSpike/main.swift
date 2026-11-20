import CoreGraphics
import CoreVideo
import Foundation
import ImageIO
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

@main
enum PhysicalDeviceStreamSpike {
    static func main() async {
        let arguments = CommandLine.arguments
        guard arguments.count >= 2 else {
            log("usage: physical-stream-spike <CoreDevice identifier> [seconds] [frame.png]")
            exit(64)
        }
        let identifier = arguments[1]
        let seconds = arguments.count > 2 ? Double(arguments[2]) ?? 10 : 10
        let framePath = arguments.count > 3 ? arguments[3] : nil
        guard CoreDeviceMediaStreamCalls.available() else {
            log("CoreDevice media stream symbols are unavailable in this Xcode")
            exit(69)
        }
        let counter = FrameCounter()
        do {
            let device = try await CoreDeviceBridge.shared.remoteDevice(udid: identifier)
            log("found device \(identifier)")
            let session = CoreDeviceMediaStreamSession(device: device, log: log)
            do {
                try await session.start { counter.record($0) }
                log("stream \(session.streamID.map(String.init) ?? "?") started: \(session.timings)")
                log("negotiated: \(session.negotiated.keys.sorted())")
                let deadline = ProcessInfo.processInfo.systemUptime + 25
                while counter.snapshot().first == nil, ProcessInfo.processInfo.systemUptime < deadline {
                    try await Task.sleep(nanoseconds: 50_000_000)
                }
                guard let first = counter.snapshot().first else { throw CoreDeviceMediaStreamError("no frame within 25 s") }
                let startCount = counter.snapshot().count
                log(String(format: "first frame %.3f s after start", first - counter.began))
                try await Task.sleep(nanoseconds: UInt64(seconds * 1_000_000_000))
                let result = counter.snapshot()
                let window = Double(result.count - startCount)
                log(String(format: "frames in %.0f s window: %d (%.2f fps); total %d; frame %dx%d", seconds,
                           result.count - startCount, window / seconds, result.count, result.size.width, result.size.height))
                if let framePath, let saved = result.saved {
                    log(writePNG(saved, to: framePath) ? "saved frame to \(framePath)" : "could not save frame")
                }
            } catch {
                log("stream failed: \(error)")
                await session.stop()
                exit(1)
            }
            await session.stop()
            log("stopped")
        } catch {
            log("error: \(error)")
            exit(1)
        }
        exit(0)
    }
}
