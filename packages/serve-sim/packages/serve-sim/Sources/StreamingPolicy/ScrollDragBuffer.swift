/// Accumulates wheel movement until the next paced touch report. Only emitted
/// positions advance the finger; excess movement survives an edge reanchor.
public struct ScrollDragBuffer: Sendable {
    private static let maximumPendingMovement = 4.0
    private static let maximumMovesPerDrain = 16
    public let anchorX: Double
    public let anchorY: Double
    public private(set) var x: Double
    public private(set) var y: Double
    private let margin: Double
    private let minimumTravelX: Double
    private let minimumTravelY: Double
    private var pendingX = 0.0
    private var pendingY = 0.0
    private var movesRemaining = 0

    public init(anchorX: Double, anchorY: Double, margin: Double = 0.08,
                minimumTravelX: Double = 0, minimumTravelY: Double = 0) {
        self.anchorX = anchorX
        self.anchorY = anchorY
        self.x = anchorX
        self.y = anchorY
        self.margin = margin
        self.minimumTravelX = minimumTravelX
        self.minimumTravelY = minimumTravelY
    }

    public var hasPendingMovement: Bool { pendingX != 0 || pendingY != 0 }

    public mutating func add(dx: Double, dy: Double) {
        guard dx.isFinite, dy.isFinite, dx != 0 || dy != 0 else { return }
        // Four displays retain ordinary wheel bursts without letting a large
        // finite input create arbitrary work. A near-edge anchor can travel
        // very little per reanchor, so distance alone cannot bound the drain.
        pendingX = min(max(pendingX + dx, -Self.maximumPendingMovement), Self.maximumPendingMovement)
        pendingY = min(max(pendingY + dy, -Self.maximumPendingMovement), Self.maximumPendingMovement)
        movesRemaining = Self.maximumMovesPerDrain
    }

    public mutating func nextMove() -> ScrollDragStep? {
        // Reanchoring cannot help if both starts have less than a pixel of
        // outward travel. Discard that axis instead of synthesizing tiny taps.
        if isBlocked(pendingX, current: x, anchor: anchorX, minimum: minimumTravelX) { pendingX = 0 }
        if isBlocked(pendingY, current: y, anchor: anchorY, minimum: minimumTravelY) { pendingY = 0 }
        guard hasPendingMovement else { return nil }
        let step = ScrollDragStep(x: x, y: y, anchorX: anchorX, anchorY: anchorY,
                                  dx: pendingX, dy: pendingY, margin: margin)
        guard step.moves else {
            // An anchor already at the outward edge cannot travel further.
            pendingX = 0
            pendingY = 0
            return nil
        }
        let originX = step.shouldReanchor ? anchorX : x
        let originY = step.shouldReanchor ? anchorY : y
        pendingX = remainder(pendingX, origin: originX, emitted: step.x)
        pendingY = remainder(pendingY, origin: originY, emitted: step.y)
        x = step.x
        y = step.y
        movesRemaining -= 1
        if movesRemaining == 0 {
            pendingX = 0
            pendingY = 0
        }
        return step
    }

    private func remainder(_ delta: Double, origin: Double, emitted: Double) -> Double {
        let destination = origin + delta
        if destination >= margin, destination <= 1 - margin { return 0 }
        return delta - (emitted - origin)
    }

    private func isBlocked(_ delta: Double, current: Double, anchor: Double, minimum: Double) -> Bool {
        if delta < 0 { return current - margin < minimum && anchor - margin < minimum }
        if delta > 0 { return 1 - margin - current < minimum && 1 - margin - anchor < minimum }
        return false
    }
}
