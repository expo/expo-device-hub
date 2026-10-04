import CoreMedia
import CoreVideo
import Foundation
import StreamingPolicy

struct NativeCapturedFrame: @unchecked Sendable {
    let pixelBuffer: CVPixelBuffer
    let timestamp: CMTime
    let wallClock: Date
}

struct NativeFrameHistoryStats: Sendable {
    var comparisons: UInt64 = 0
    var comparisonSumNs: UInt64 = 0
    var comparisonMaxNs: UInt64 = 0
    var duplicateFrames: UInt64 = 0
    var overloadDrops: UInt64 = 0
    var staleDrops: UInt64 = 0
    var finalizationDrops: UInt64 = 0
    var maxRetainedFrames = 0
    var pendingFrames = 0
}

final class NativeFrameMailbox: @unchecked Sendable {
    private struct Entry {
        let frame: NativeCapturedFrame
        let publishedNs: UInt64
    }

    // Recorder-only history keeps short bursts of distinct pictures in order.
    // The latest frame remains available independently of the recording backlog.
    private static let historyCapacity = 3
    private static let maximumHistoryAge = RecordingFramePacer.intervalNanoseconds * 4
    private let lock = NSLock()
    private let publicationLock = NSLock()
    private var frame: NativeCapturedFrame?
    private var active = false
    private var recording = false
    // A capture pause invalidates publications without ending the recording's lease.
    private var publicationGeneration: UInt64 = 0
    private var recordingGeneration: UInt64?
    private var canonical: NativeCapturedFrame?
    private var history: [Entry] = []
    private var stats = NativeFrameHistoryStats()

    func publish(_ pixelBuffer: CVPixelBuffer, timestamp: CMTime, wallClock: Date,
                 atNanoseconds now: UInt64? = nil) {
        lock.lock()
        guard active else { lock.unlock(); return }
        if !recording {
            frame = NativeCapturedFrame(pixelBuffer: pixelBuffer, timestamp: timestamp, wallClock: wallClock)
            lock.unlock()
            return
        }
        let acceptedGeneration = publicationGeneration
        lock.unlock()

        publicationLock.lock()
        defer { publicationLock.unlock() }
        lock.lock()
        guard active, acceptedGeneration == publicationGeneration else { lock.unlock(); return }
        let previous = recording ? canonical?.pixelBuffer : nil
        lock.unlock()

        let comparisonStart = DispatchTime.now().uptimeNanoseconds
        let unchanged = previous.map { Self.samePixels($0, pixelBuffer) } ?? false
        let comparisonNs = DispatchTime.now().uptimeNanoseconds - comparisonStart

        lock.lock()
        defer { lock.unlock() }
        guard active, acceptedGeneration == publicationGeneration else { return }
        let captured = NativeCapturedFrame(pixelBuffer: pixelBuffer, timestamp: timestamp, wallClock: wallClock)
        frame = captured
        guard recording else { return }
        if previous != nil {
            stats.comparisons &+= 1
            stats.comparisonSumNs &+= comparisonNs
            stats.comparisonMaxNs = max(stats.comparisonMaxNs, comparisonNs)
        }
        if unchanged {
            stats.duplicateFrames &+= 1
        } else {
            canonical = captured
            if history.count == Self.historyCapacity {
                history.removeFirst()
                stats.overloadDrops &+= 1
            }
            history.append(Entry(frame: captured, publishedNs: now ?? DispatchTime.now().uptimeNanoseconds))
        }
        updateRetainedCount()
    }

    func setActive(_ value: Bool) {
        lock.lock()
        defer { lock.unlock() }
        guard active != value else { return }
        active = value
        publicationGeneration &+= 1
        if !value {
            frame = nil
            canonical = nil
            history.removeAll(keepingCapacity: true)
        }
    }

    @discardableResult
    func beginRecording(atNanoseconds now: UInt64? = nil) -> UInt64? {
        lock.lock()
        defer { lock.unlock() }
        guard active, !recording else { return nil }
        publicationGeneration &+= 1
        recording = true
        recordingGeneration = publicationGeneration
        stats = NativeFrameHistoryStats()
        canonical = frame
        history.removeAll(keepingCapacity: true)
        if let frame {
            history.append(Entry(frame: frame, publishedNs: now ?? DispatchTime.now().uptimeNanoseconds))
        }
        updateRetainedCount()
        return recordingGeneration
    }

    func endRecording(generation expectedGeneration: UInt64) {
        lock.lock()
        defer { lock.unlock() }
        guard recording, recordingGeneration == expectedGeneration else { return }
        publicationGeneration &+= 1
        recording = false
        recordingGeneration = nil
        canonical = nil
        history.removeAll(keepingCapacity: true)
    }

    func nextForRecording(atNanoseconds now: UInt64 = DispatchTime.now().uptimeNanoseconds,
                          finishing: Bool = false) -> NativeCapturedFrame? {
        lock.lock()
        defer { lock.unlock() }
        guard active, recording else { return nil }
        if finishing {
            stats.finalizationDrops &+= UInt64(max(0, history.count - 1))
            history.removeAll(keepingCapacity: true)
            return canonical
        }
        // After a consumer stall, prefer fresh content over replaying an old backlog.
        while history.count > 1, let first = history.first,
              now > first.publishedNs, now - first.publishedNs > Self.maximumHistoryAge {
            history.removeFirst()
            stats.staleDrops &+= 1
        }
        return history.isEmpty ? canonical : history.removeFirst().frame
    }

    var historyStats: NativeFrameHistoryStats {
        lock.lock()
        defer { lock.unlock() }
        var result = stats
        result.pendingFrames = history.count
        return result
    }

    func latest() -> NativeCapturedFrame? {
        lock.lock()
        defer { lock.unlock() }
        return frame
    }

    private func updateRetainedCount() {
        var buffers = history.map { $0.frame.pixelBuffer }
        for retained in [canonical?.pixelBuffer, frame?.pixelBuffer].compactMap({ $0 })
            where !buffers.contains(where: { $0 === retained }) {
            buffers.append(retained)
        }
        stats.maxRetainedFrames = max(stats.maxRetainedFrames, buffers.count)
    }

    private static func samePixels(_ a: CVPixelBuffer, _ b: CVPixelBuffer) -> Bool {
        let format = CVPixelBufferGetPixelFormatType(a)
        let planar = format == kCVPixelFormatType_420YpCbCr8BiPlanarVideoRange
            || format == kCVPixelFormatType_420YpCbCr8BiPlanarFullRange
        guard planar || format == kCVPixelFormatType_32BGRA,
              CVPixelBufferGetPixelFormatType(b) == format,
              CVPixelBufferGetWidth(a) == CVPixelBufferGetWidth(b),
              CVPixelBufferGetHeight(a) == CVPixelBufferGetHeight(b) else { return false }
        let attachmentsA = CVBufferCopyAttachments(a, .shouldPropagate)
        let attachmentsB = CVBufferCopyAttachments(b, .shouldPropagate)
        if let attachmentsA, let attachmentsB {
            guard CFEqual(attachmentsA, attachmentsB) else { return false }
        } else if attachmentsA != nil || attachmentsB != nil {
            return false
        }
        guard CVPixelBufferLockBaseAddress(a, .readOnly) == kCVReturnSuccess else { return false }
        defer { CVPixelBufferUnlockBaseAddress(a, .readOnly) }
        guard CVPixelBufferLockBaseAddress(b, .readOnly) == kCVReturnSuccess else { return false }
        defer { CVPixelBufferUnlockBaseAddress(b, .readOnly) }
        if planar {
            for plane in 0..<2 {
                guard let baseA = CVPixelBufferGetBaseAddressOfPlane(a, plane),
                      let baseB = CVPixelBufferGetBaseAddressOfPlane(b, plane) else { return false }
                let rowBytes = CVPixelBufferGetWidthOfPlane(a, plane) * (plane == 0 ? 1 : 2)
                guard FramePlanes.equal(
                    baseA, bytesPerRow: CVPixelBufferGetBytesPerRowOfPlane(a, plane),
                    baseB, bytesPerRow: CVPixelBufferGetBytesPerRowOfPlane(b, plane),
                    rowBytes: rowBytes, rows: CVPixelBufferGetHeightOfPlane(a, plane)
                ) else { return false }
            }
            return true
        }
        guard let baseA = CVPixelBufferGetBaseAddress(a),
              let baseB = CVPixelBufferGetBaseAddress(b) else { return false }
        return FramePlanes.equal(
            baseA, bytesPerRow: CVPixelBufferGetBytesPerRow(a),
            baseB, bytesPerRow: CVPixelBufferGetBytesPerRow(b),
            rowBytes: CVPixelBufferGetWidth(a) * 4, rows: CVPixelBufferGetHeight(a)
        )
    }
}
