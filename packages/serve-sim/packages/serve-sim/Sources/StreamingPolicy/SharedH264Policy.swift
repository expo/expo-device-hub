public struct SharedH264Policy {
    private var peerBitrates: [Int: Int] = [:]
    private var newestTimestamp = Int64.min
    private var forceNextIDR = false
    private let defaultBitrate: Int
    /// Peers whose encode calls only bring timestamps older than the newest frame. Such a
    /// peer lags the others by more than the completed-frame cache and would otherwise never
    /// receive a frame again. It gets the next keyframe instead.
    private var starvedPeers = Set<Int>()
    public private(set) var starvedRecoveries: UInt64 = 0
    /// Frame time of the last keyframe a refused delivery forced.
    private var lastRefusalIDRTimestamp: Int64?
    /// Refused deliveries force at most one keyframe per this much frame time.
    public static let refusalIDRIntervalNanoseconds: Int64 = 1_000_000_000
    /// A refusal inside the interval could not force a keyframe; the first frame after it does,
    /// if a peer still waits. Otherwise a sender that paused briefly would wait for the encoder's
    /// natural keyframe, because the deltas it then accepts cannot restart its stream.
    private var deferredRefusalIDR = false

    public init(defaultBitrate: Int) {
        self.defaultBitrate = max(1, defaultBitrate)
    }

    public var bitrate: Int {
        peerBitrates.values.min() ?? defaultBitrate
    }

    public mutating func join(peer: Int, bitrate: Int) {
        peerBitrates[peer] = max(1, bitrate)
        forceNextIDR = true
    }

    public mutating func leave(peer: Int) {
        peerBitrates.removeValue(forKey: peer)
        starvedPeers.remove(peer)
    }

    /// A peer asked for a frame older than the newest and no longer cached. The next frame
    /// is forced to a keyframe for it. Returns true the first time a peer is marked.
    @discardableResult
    public mutating func frameWasStale(peer: Int) -> Bool {
        let newlyStarved = starvedPeers.insert(peer).inserted
        if newlyStarved { forceNextIDR = true }
        return newlyStarved
    }

    /// The peer's sender refused the frame with capture time `frameTimestamp`, for example because
    /// it is not active yet or is paused. It waits for the next keyframe like a starved peer. The
    /// first refusal forces one, so a viewer whose sender activates late still starts at once, but
    /// later ones force at most one per `refusalIDRIntervalNanoseconds`: a sender that keeps
    /// refusing would otherwise make every keyframe force the next, and every viewer would get a
    /// keyframe-only stream. A refusal inside the interval defers its keyframe to the interval's end.
    public mutating func deliveryRejected(peer: Int, frameTimestamp: Int64) {
        starvedPeers.insert(peer)
        if let last = lastRefusalIDRTimestamp,
           frameTimestamp &- last < Self.refusalIDRIntervalNanoseconds {
            deferredRefusalIDR = true
            return
        }
        lastRefusalIDRTimestamp = frameTimestamp
        forceNextIDR = true
        deferredRefusalIDR = false
    }

    /// The peer received a frame through the normal path; it is no longer starved.
    public mutating func caughtUp(peer: Int) {
        starvedPeers.remove(peer)
    }

    /// The peers a completed keyframe must also go to, beyond the ones that asked for it.
    /// Clears them: the keyframe restarts their stream.
    public mutating func takeStarvedPeers(excluding served: Set<Int>) -> Set<Int> {
        let extra = starvedPeers.subtracting(served)
        starvedRecoveries &+= UInt64(extra.count)
        starvedPeers.removeAll()
        deferredRefusalIDR = false
        return extra
    }

    public var isAnyPeerStarved: Bool { !starvedPeers.isEmpty }

    public mutating func setBitrate(_ bitrate: Int, peer: Int) {
        guard peerBitrates[peer] != nil else { return }
        peerBitrates[peer] = max(1, bitrate)
    }

    public mutating func requestIDR() {
        forceNextIDR = true
    }

    public mutating func beginFrame(timestamp: Int64, requestedIDR: Bool) -> Bool? {
        guard timestamp > newestTimestamp else { return nil }
        newestTimestamp = timestamp
        if deferredRefusalIDR, !starvedPeers.isEmpty, let last = lastRefusalIDRTimestamp,
           timestamp &- last >= Self.refusalIDRIntervalNanoseconds {
            lastRefusalIDRTimestamp = timestamp
            deferredRefusalIDR = false
            forceNextIDR = true
        }
        let force = forceNextIDR || requestedIDR
        forceNextIDR = false
        return force
    }
}

public struct SharedFrameBacklog {
    public enum Submission: Equatable {
        case start
        case queued(replaced: Int64?)
        case stale
    }

    public private(set) var encodingTimestamp: Int64?
    public private(set) var queuedTimestamp: Int64?
    private var newestTimestamp = Int64.min

    public init() {}

    public mutating func submit(_ timestamp: Int64) -> Submission {
        guard timestamp > newestTimestamp else { return .stale }
        newestTimestamp = timestamp
        if encodingTimestamp == nil {
            encodingTimestamp = timestamp
            return .start
        }
        let replaced = queuedTimestamp
        queuedTimestamp = timestamp
        return .queued(replaced: replaced)
    }

    public mutating func complete(_ timestamp: Int64) -> Int64? {
        guard encodingTimestamp == timestamp else { return nil }
        encodingTimestamp = queuedTimestamp
        queuedTimestamp = nil
        return encodingTimestamp
    }

    public mutating func discardQueued() {
        queuedTimestamp = nil
    }

    public mutating func stop() {
        encodingTimestamp = nil
        queuedTimestamp = nil
    }
}

public struct LetterboxPlacement: Equatable {
    public let x: Int
    public let y: Int
    public let width: Int
    public let height: Int

    public init(sourceWidth: Int, sourceHeight: Int, canvasWidth: Int, canvasHeight: Int) {
        guard sourceWidth > 0, sourceHeight > 0, canvasWidth > 0, canvasHeight > 0 else {
            x = 0; y = 0; width = 0; height = 0
            return
        }
        let scale = min(Double(canvasWidth) / Double(sourceWidth),
                        Double(canvasHeight) / Double(sourceHeight))
        width = max(2, Int(Double(sourceWidth) * scale) & ~1)
        height = max(2, Int(Double(sourceHeight) * scale) & ~1)
        x = ((canvasWidth - width) / 2) & ~1
        y = ((canvasHeight - height) / 2) & ~1
    }

    /// Columns or rows past a top-left picture that repeat its edge. A client that scales the
    /// frame down can blend this far past the picture's edge; the rest of the unused canvas
    /// stays black, so it costs the encoder nothing while the picture changes.
    public static let edgeGuard = 8

    /// The picture with its edge guard, clipped to the canvas.
    public func guarded(canvasWidth: Int, canvasHeight: Int) -> LetterboxPlacement {
        LetterboxPlacement(
            x: x, y: y,
            width: width < canvasWidth ? min(canvasWidth - x, width + Self.edgeGuard) : width,
            height: height < canvasHeight ? min(canvasHeight - y, height + Self.edgeGuard) : height
        )
    }

    public init(x: Int, y: Int, width: Int, height: Int) {
        self.x = x
        self.y = y
        self.width = width
        self.height = height
    }

    /// The live viewer canvas: the picture keeps its proportions and starts at the top-left
    /// corner, so a client shows the whole screen by pinning the frame top-left in a box with the
    /// screen's proportions. Sizes round up to even, never past the canvas, so no unused column
    /// or row sits inside the picture. An iPhone Duo cover screen in the canvas sized for its
    /// inner screen leaves its unused columns on the right only.
    // @ref LLP 0001#viewer-frame-placement — clients pin the frame top-left, so the unused area stays out of view
    public static func topLeft(sourceWidth: Int, sourceHeight: Int,
                               canvasWidth: Int, canvasHeight: Int) -> LetterboxPlacement {
        guard sourceWidth > 0, sourceHeight > 0, canvasWidth > 0, canvasHeight > 0 else {
            return LetterboxPlacement(x: 0, y: 0, width: 0, height: 0)
        }
        let scale = min(Double(canvasWidth) / Double(sourceWidth),
                        Double(canvasHeight) / Double(sourceHeight))
        // The tolerance keeps a size that is exact up to rounding error from rounding up.
        let evenCeiling = { (value: Double, limit: Int) in
            min(limit, max(2, (Int((value - 1e-6).rounded(.up)) + 1) & ~1))
        }
        return LetterboxPlacement(x: 0, y: 0,
                                  width: evenCeiling(Double(sourceWidth) * scale, canvasWidth),
                                  height: evenCeiling(Double(sourceHeight) * scale, canvasHeight))
    }
}
