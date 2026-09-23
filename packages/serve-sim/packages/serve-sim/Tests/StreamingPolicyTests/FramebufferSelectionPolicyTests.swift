import Testing

@testable import StreamingPolicy

@Suite("FramebufferSelectionPolicy")
struct FramebufferSelectionPolicyTests {
    private let duo = [
        FramebufferSurfaceCandidate(screenID: 1, area: 1398 * 2034),
        FramebufferSurfaceCandidate(screenID: 3, area: 2007 * 2853),
    ]

    @Test("closing selects the active outer panel even while the larger inner surface remains live")
    func closedPanel() {
        #expect(FramebufferSelectionPolicy.preferredIndex(in: duo, activeScreenID: 1) == 0)
    }

    @Test("opening selects the active inner panel")
    func openPanel() {
        #expect(FramebufferSelectionPolicy.preferredIndex(in: duo, activeScreenID: 3) == 1)
    }

    @Test("fixed panel capture ignores another active panel")
    func fixedPanel() {
        #expect(FramebufferSelectionPolicy.preferredIndex(in: duo, activeScreenID: 3, fixedScreenID: 1) == 0)
        #expect(FramebufferSelectionPolicy.preferredIndex(in: duo, activeScreenID: 1, fixedScreenID: 3) == 1)
        #expect(FramebufferSelectionPolicy.preferredIndex(in: duo, activeScreenID: nil, fixedScreenID: 1) == 0)
    }

    @Test("fixed panel capture never substitutes another panel when its surface is unavailable")
    func missingFixedPanel() {
        let candidates = [duo[0], FramebufferSurfaceCandidate(screenID: 3, area: 0)]
        #expect(FramebufferSelectionPolicy.preferredIndex(in: candidates, activeScreenID: 1, fixedScreenID: 3) == nil)
        #expect(FramebufferSelectionPolicy.preferredIndex(in: duo, activeScreenID: 1, fixedScreenID: 99) == nil)
        #expect(FramebufferSelectionPolicy.preferredIndex(in: [], activeScreenID: 1, fixedScreenID: 3) == nil)
        #expect(FramebufferSelectionPolicy.preferredIndex(in: [FramebufferSurfaceCandidate(screenID: nil, area: 100)], activeScreenID: nil, fixedScreenID: 3) == nil)
    }

    @Test("fixed panel capture chooses the largest surface only within that panel")
    func fixedPanelPlanes() {
        let candidates = duo + [FramebufferSurfaceCandidate(screenID: 1, area: 10)]
        #expect(FramebufferSelectionPolicy.preferredIndex(in: candidates, activeScreenID: 3, fixedScreenID: 1) == 0)
    }

    @Test("missing or unavailable active screen metadata preserves largest-surface fallback")
    func legacyFallback() {
        #expect(FramebufferSelectionPolicy.preferredIndex(in: duo, activeScreenID: nil) == 1)
        #expect(FramebufferSelectionPolicy.preferredIndex(in: duo, activeScreenID: 99) == 1)
        let legacy = [FramebufferSurfaceCandidate(screenID: nil, area: 100)]
        #expect(FramebufferSelectionPolicy.preferredIndex(in: legacy, activeScreenID: 1) == 0)
    }

    @Test("an active descriptor without usable pixels does not replace a live surface")
    func emptySurface() {
        let candidates = duo + [FramebufferSurfaceCandidate(screenID: 5, area: 0)]
        #expect(FramebufferSelectionPolicy.preferredIndex(in: candidates, activeScreenID: 5) == 1)
        #expect(FramebufferSelectionPolicy.preferredIndex(in: [], activeScreenID: 1) == nil)
    }
}
