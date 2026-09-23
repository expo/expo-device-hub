import Testing

@testable import StreamingPolicy

@Suite("ScrollDragStep")
struct ScrollDragStepTests {
    @Test("an oversized first wheel delta moves to the edge without lifting")
    func largeFirstDelta() {
        let step = ScrollDragStep(x: 0.5, y: 0.5, anchorX: 0.5, anchorY: 0.5, dx: -0.51, dy: 0)
        #expect(step.x == 0.08)
        #expect(step.y == 0.5)
        #expect(step.moves)
        #expect(!step.shouldReanchor)
    }

    @Test("continued outward scrolling reanchors a finger that reached the edge")
    func continuedOutwardDelta() {
        let step = ScrollDragStep(x: 0.08, y: 0.5, anchorX: 0.5, anchorY: 0.5, dx: -0.2, dy: 0)
        #expect(step.x == 0.3)
        #expect(step.y == 0.5)
        #expect(step.moves)
        #expect(step.shouldReanchor)
    }

    @Test("reversing direction at the edge continues the existing gesture")
    func reversesAtEdge() {
        let step = ScrollDragStep(x: 0.08, y: 0.5, anchorX: 0.5, anchorY: 0.5, dx: 0.2, dy: 0)
        #expect(step.x == 0.28)
        #expect(step.moves)
        #expect(!step.shouldReanchor)
    }

    @Test("outward scrolling from an edge anchor does not synthesize a tap")
    func noStationaryGesture() {
        let step = ScrollDragStep(x: 0.08, y: 0.5, anchorX: 0.08, anchorY: 0.5, dx: -0.2, dy: 0)
        #expect(!step.moves)
        #expect(!step.shouldReanchor)
    }

    @Test("moving along an edge does not repeatedly reanchor")
    func movesAlongEdge() {
        let step = ScrollDragStep(x: 0.08, y: 0.5, anchorX: 0.5, anchorY: 0.5, dx: 0, dy: 0.2)
        #expect(step.x == 0.08)
        #expect(step.y == 0.7)
        #expect(step.moves)
        #expect(!step.shouldReanchor)
    }
}
