import CoreVideo
import Foundation

/// EAS benchmark branch only. SERVE_SIM_FRAME_TRACE=<file> logs each capture copy, each frame the
/// pacer is offered, and each send, with the sim-perf-probe frame counter read from the frame, so
/// a benchmark can tell where an app frame was lost. Lines, times in uptime nanoseconds:
///
///   h <uptime> <unix ms>              once, to align with wall-clock logs
///   c <entry> <copied> <trigger>      a capture copy: f frame callback, s surfaces changed, p poll
///   a <uptime> <counter> <unchanged>  a frame offered to the pacer (1 when the fingerprint matched)
///   s <uptime> <counter>              a frame sent
///
/// The counter is -1 when the beacon is unreadable. SERVE_SIM_FRAME_TRACE_POINTS is the screen
/// width in points (402, an iPhone 17, by default).
final class FrameTrace: @unchecked Sendable {
    static let shared: FrameTrace? = ProcessInfo.processInfo.environment["SERVE_SIM_FRAME_TRACE"]
        .flatMap { $0.isEmpty ? nil : FrameTrace(path: $0) }

    private let handle: FileHandle
    private let lock = NSLock()
    private var buffer = Data()
    private let screenWidthPoints: Double

    private init?(path: String) {
        guard FileManager.default.createFile(atPath: path, contents: nil),
              let handle = FileHandle(forWritingAtPath: path) else { return nil }
        self.handle = handle
        screenWidthPoints = Double(ProcessInfo.processInfo.environment["SERVE_SIM_FRAME_TRACE_POINTS"] ?? "") ?? 402
        log("h \(DispatchTime.now().uptimeNanoseconds) \(Int64(Date().timeIntervalSince1970 * 1000))")
    }

    func log(_ line: String) {
        lock.lock()
        buffer.append(contentsOf: Array((line + "\n").utf8))
        // Small writes: the runner stops serve-sim with SIGTERM, which drops what is still buffered.
        if buffer.count >= 2_048 {
            handle.write(buffer)
            buffer.removeAll(keepingCapacity: true)
        }
        lock.unlock()
    }

    /// The probe's beacon (probe/Sources/Beacon.swift): a mid-gray box at (12, 100) points holding
    /// 16 counter squares, least significant first, and one phase square, 16 points each with
    /// 2-point gaps.
    func counter(_ pixelBuffer: CVPixelBuffer) -> Int {
        let format = CVPixelBufferGetPixelFormatType(pixelBuffer)
        let planar = format == kCVPixelFormatType_420YpCbCr8BiPlanarVideoRange
            || format == kCVPixelFormatType_420YpCbCr8BiPlanarFullRange
        guard planar || format == kCVPixelFormatType_32BGRA,
              CVPixelBufferLockBaseAddress(pixelBuffer, .readOnly) == kCVReturnSuccess else { return -1 }
        defer { CVPixelBufferUnlockBaseAddress(pixelBuffer, .readOnly) }
        guard let base = planar ? CVPixelBufferGetBaseAddressOfPlane(pixelBuffer, 0) : CVPixelBufferGetBaseAddress(pixelBuffer)
        else { return -1 }
        let width = CVPixelBufferGetWidth(pixelBuffer), height = CVPixelBufferGetHeight(pixelBuffer)
        let bytesPerRow = planar ? CVPixelBufferGetBytesPerRowOfPlane(pixelBuffer, 0) : CVPixelBufferGetBytesPerRow(pixelBuffer)
        let bytes = base.assumingMemoryBound(to: UInt8.self)
        let scale = Double(width) / screenWidthPoints
        func luma(_ x: Int, _ y: Int) -> Double {
            let row = bytes + y * bytesPerRow
            if planar { return Double(row[x]) }
            let pixel = row + x * 4
            return 0.114 * Double(pixel[0]) + 0.587 * Double(pixel[1]) + 0.299 * Double(pixel[2])
        }
        func sample(_ xPoints: Double, _ yPoints: Double, radiusPoints: Double) -> Double? {
            let cx = Int(((12 + xPoints) * scale).rounded()), cy = Int(((100 + yPoints) * scale).rounded())
            let r = max(1, Int(radiusPoints * scale))
            guard cx - r >= 0, cy - r >= 0, cx + r < width, cy + r < height else { return nil }
            var sum = 0.0
            for y in (cy - r)...(cy + r) { for x in (cx - r)...(cx + r) { sum += luma(x, y) } }
            return sum / Double((2 * r + 1) * (2 * r + 1))
        }
        guard let pad = sample(2, 12, radiusPoints: 1), pad > 90, pad < 170 else { return -1 }
        var counter = 0, phase = 0
        for i in 0...16 {
            guard let value = sample(4 + Double(i) * 18 + 8, 12, radiusPoints: 3.2) else { return -1 }
            let bit = value > 128 ? 1 : 0
            if i < 16 { counter |= bit << i } else { phase = bit }
        }
        return phase == (counter & 1) ? counter : -1
    }
}
