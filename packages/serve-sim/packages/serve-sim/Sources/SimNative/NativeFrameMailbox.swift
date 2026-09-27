import CoreMedia
import CoreVideo
import Foundation

struct NativeCapturedFrame: @unchecked Sendable {
    let pixelBuffer: CVPixelBuffer
    let timestamp: CMTime
    let wallClock: Date
}

final class NativeFrameMailbox: @unchecked Sendable {
    private let lock = NSLock()
    private var frame: NativeCapturedFrame?
    private var active = false

    func publish(_ pixelBuffer: CVPixelBuffer, timestamp: CMTime, wallClock: Date) {
        lock.lock()
        if active {
            frame = NativeCapturedFrame(pixelBuffer: pixelBuffer, timestamp: timestamp, wallClock: wallClock)
        }
        lock.unlock()
    }

    func setActive(_ value: Bool) {
        lock.lock()
        active = value
        if !value { frame = nil }
        lock.unlock()
    }

    func latest() -> NativeCapturedFrame? {
        lock.lock()
        defer { lock.unlock() }
        return frame
    }

}
