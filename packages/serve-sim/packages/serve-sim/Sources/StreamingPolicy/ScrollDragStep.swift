/// A wheel delta translated into one finger movement. Reach an edge before
/// lifting to reanchor: lifting a fresh, unmoved finger would inject a tap.
public struct ScrollDragStep: Sendable {
    public let x: Double
    public let y: Double
    public let shouldReanchor: Bool
    public let moves: Bool

    public init(x: Double, y: Double, anchorX: Double, anchorY: Double,
                dx: Double, dy: Double, margin: Double = 0.08) {
        let pushesPastEdge = (x <= margin && dx < 0) || (x >= 1 - margin && dx > 0)
            || (y <= margin && dy < 0) || (y >= 1 - margin && dy > 0)
        shouldReanchor = pushesPastEdge && (x != anchorX || y != anchorY)
        let originX = shouldReanchor ? anchorX : x
        let originY = shouldReanchor ? anchorY : y
        self.x = min(max(originX + dx, margin), 1 - margin)
        self.y = min(max(originY + dy, margin), 1 - margin)
        moves = self.x != originX || self.y != originY
    }
}
