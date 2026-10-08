import Testing

@testable import StreamingPolicy

@Suite("ScrollDragBuffer")
struct ScrollDragBufferTests {
    @Test("large finite inputs cannot overflow or enqueue more than four displays of movement")
    func boundsLargeInput() {
        var drag = ScrollDragBuffer(anchorX: 0.5, anchorY: 0.5)
        drag.add(dx: Double.greatestFiniteMagnitude, dy: Double.greatestFiniteMagnitude)
        drag.add(dx: Double.greatestFiniteMagnitude, dy: Double.greatestFiniteMagnitude)
        var previousX = 0.5
        var previousY = 0.5
        var totalX = 0.0
        var totalY = 0.0
        for _ in 0..<16 {
            guard let move = drag.nextMove() else { break }
            totalX += move.x - (move.shouldReanchor ? 0.5 : previousX)
            totalY += move.y - (move.shouldReanchor ? 0.5 : previousY)
            previousX = move.x
            previousY = move.y
        }
        #expect(abs(totalX - 4) < 0.000001)
        #expect(abs(totalY - 4) < 0.000001)
        #expect(!drag.hasPendingMovement)
    }

    @Test("a subpixel edge anchor does not synthesize repeated touch lifecycles")
    func boundsNearEdgeDrain() {
        var drag = ScrollDragBuffer(anchorX: 0.0800001, anchorY: 0.5,
                                    minimumTravelX: 1.0 / 1000, minimumTravelY: 1.0 / 1000)
        drag.add(dx: -0.5, dy: 0)
        #expect(drag.nextMove() == nil)
        #expect(!drag.hasPendingMovement)
    }

    @Test("blocking subpixel outward movement preserves the other axis")
    func subpixelAxisDoesNotBlockOtherAxis() throws {
        var drag = ScrollDragBuffer(anchorX: 0.0800001, anchorY: 0.5,
                                    minimumTravelX: 1.0 / 1000, minimumTravelY: 1.0 / 1000)
        drag.add(dx: -0.5, dy: 0.2)
        let next = drag.nextMove()
        let move = try #require(next)
        #expect(move.x == 0.0800001)
        #expect(move.y == 0.7)
        #expect(!move.shouldReanchor)
        #expect(!drag.hasPendingMovement)
    }

    @Test("near-edge input is ignored before synthesizing tiny repeated drags")
    func rejectsInsufficientEdgeTravel() {
        var drag = ScrollDragBuffer(anchorX: 0.0811, anchorY: 0.5,
                                    minimumTravelX: 1.0 / 1000, minimumTravelY: 1.0 / 1000)
        drag.add(dx: -0.5, dy: 0)
        #expect(drag.nextMove() == nil)
        #expect(!drag.hasPendingMovement)
    }

    @Test("insufficient edge travel preserves useful movement on the other axis")
    func rejectsTinyReanchorsWithoutBlockingOtherAxis() throws {
        var drag = ScrollDragBuffer(anchorX: 0.0811, anchorY: 0.5,
                                    minimumTravelX: 1.0 / 1000, minimumTravelY: 1.0 / 1000)
        drag.add(dx: -0.5, dy: 0.2)
        let next = drag.nextMove()
        let move = try #require(next)
        #expect(move.x == 0.0811)
        #expect(move.y == 0.7)
        #expect(!drag.hasPendingMovement)
    }

    @Test("an edge drag with enough room preserves the requested distance")
    func preservesUsefulEdgeTravel() {
        var drag = ScrollDragBuffer(anchorX: 0.12, anchorY: 0.5,
                                    minimumTravelX: 1.0 / 1000, minimumTravelY: 1.0 / 1000)
        drag.add(dx: -0.5, dy: 0)
        var previousX = 0.12
        var distance = 0.0
        var moves = 0
        while let move = drag.nextMove() {
            distance += (move.shouldReanchor ? 0.12 : previousX) - move.x
            previousX = move.x
            moves += 1
        }
        #expect(abs(distance - 0.5) < 0.000001)
        #expect(moves <= 16)
        #expect(!drag.hasPendingMovement)
    }

    @Test("a burst retains every wheel delta while coalescing movement")
    func sumsBurst() throws {
        var drag = ScrollDragBuffer(anchorX: 0.5, anchorY: 0.5)
        for _ in 0..<5 { drag.add(dx: 0, dy: -0.03) }
        let next = drag.nextMove()
        let move = try #require(next)
        #expect(abs(move.y - 0.35) < 0.000001)
        #expect(!move.shouldReanchor)
        #expect(!drag.hasPendingMovement)
        #expect(drag.nextMove() == nil)
    }

    @Test("movement beyond an edge survives reanchoring without lifting the first move")
    func keepsMovementAcrossEdges() throws {
        var drag = ScrollDragBuffer(anchorX: 0.5, anchorY: 0.5)
        drag.add(dx: -1.3, dy: 0.12)
        var totalX = 0.0
        var totalY = 0.0
        var previousX = 0.5
        var previousY = 0.5
        var moves = 0

        while let move = drag.nextMove() {
            if moves == 0 { #expect(!move.shouldReanchor) }
            if move.shouldReanchor {
                #expect(previousX == 0.08)
            }
            totalX += move.x - (move.shouldReanchor ? 0.5 : previousX)
            totalY += move.y - (move.shouldReanchor ? 0.5 : previousY)
            previousX = move.x
            previousY = move.y
            moves += 1
            #expect(moves <= 4)
        }

        #expect(moves == 4)
        #expect(abs(totalX + 1.3) < 0.000001)
        #expect(abs(totalY - 0.12) < 0.000001)
        #expect(!drag.hasPendingMovement)
    }

    @Test("more wheel input adds to the remainder of an emitted edge move")
    func extendsPendingMovement() throws {
        var drag = ScrollDragBuffer(anchorX: 0.5, anchorY: 0.5)
        drag.add(dx: 0, dy: -0.6)
        let first = drag.nextMove()
        let edge = try #require(first)
        #expect(edge.y == 0.08)
        #expect(drag.hasPendingMovement)

        drag.add(dx: 0, dy: -0.1)
        let next = drag.nextMove()
        let remaining = try #require(next)
        #expect(remaining.shouldReanchor)
        #expect(abs(remaining.y - 0.22) < 0.000001)
        #expect(!drag.hasPendingMovement)
    }

    @Test("opposite deltas cancel pending movement without synthesizing a tap")
    func cancelsPendingMovement() {
        var drag = ScrollDragBuffer(anchorX: 0.5, anchorY: 0.5)
        drag.add(dx: 0.2, dy: -0.1)
        drag.add(dx: -0.2, dy: 0.1)
        #expect(!drag.hasPendingMovement)
        #expect(drag.nextMove() == nil)
    }

    @Test("an immovable edge axis does not prevent movement along the edge")
    func edgeAnchor() throws {
        var drag = ScrollDragBuffer(anchorX: 0.08, anchorY: 0.5)
        drag.add(dx: -0.2, dy: 0.2)
        let next = drag.nextMove()
        let alongEdge = try #require(next)
        #expect(alongEdge.x == 0.08)
        #expect(alongEdge.y == 0.7)
        #expect(!alongEdge.shouldReanchor)
        #expect(drag.nextMove() == nil)
        #expect(!drag.hasPendingMovement)

        var blocked = ScrollDragBuffer(anchorX: 0.08, anchorY: 0.5)
        blocked.add(dx: -0.2, dy: 0)
        #expect(blocked.nextMove() == nil)
    }
}
