import Testing
@testable import StreamingPolicy

@Suite("Scroll gesture idle")
struct ScrollGestureIdleTests {
    @Test("a burst returns without waiting for touch-up")
    func burstDoesNotWaitForIdle() {
        var idle = ScrollGestureIdle()
        defer { idle.cancel() }
        for _ in 0..<100 {
            idle.schedule(after: .seconds(60)) { _ in
                Issue.record("a superseded scroll timer fired")
            }
        }
    }

    @Test("only the latest wheel event can finish a drag")
    func latestEventOwnsTouchUp() async {
        var idle = ScrollGestureIdle()
        defer { idle.cancel() }
        let callbacks = IdleCallbacks()
        idle.schedule(after: .zero) { await callbacks.record($0) }
        let old = await callbacks.next()
        idle.schedule(after: .zero) { await callbacks.record($0) }
        let current = await callbacks.next()
        let staleFinished = idle.finish(old)
        let currentFinished = idle.finish(current)
        let repeatedFinished = idle.finish(current)
        #expect(!staleFinished)
        #expect(currentFinished)
        #expect(!repeatedFinished)
    }

    @Test("a touch handoff invalidates even an already-delivered idle callback")
    func touchHandoffInvalidatesIdle() async {
        var idle = ScrollGestureIdle()
        let callbacks = IdleCallbacks()
        idle.schedule(after: .zero) { await callbacks.record($0) }
        let expired = await callbacks.next()
        idle.cancel()
        let finished = idle.finish(expired)
        #expect(!finished)
    }
}

private actor IdleCallbacks {
    private var pending: UInt64?
    private var waiter: CheckedContinuation<UInt64, Never>?

    func record(_ generation: UInt64) {
        if let waiter {
            self.waiter = nil
            waiter.resume(returning: generation)
        } else {
            pending = generation
        }
    }

    func next() async -> UInt64 {
        if let pending {
            self.pending = nil
            return pending
        }
        return await withCheckedContinuation { waiter = $0 }
    }
}
