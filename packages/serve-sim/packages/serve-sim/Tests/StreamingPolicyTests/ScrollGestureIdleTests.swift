import Testing

@testable import StreamingPolicy

@Suite("ScrollGestureIdle")
struct ScrollGestureIdleTests {
    @Test("selecting another panel fences pending wheel moves and releases the original panel")
    func panelChangeInterruptsWheel() {
        var idle = ScrollGestureIdle()
        var target = HIDTargetPolicy()
        #expect(idle.selectScreen(3) == false)
        target.setScreen(3, universalHID: true)
        #expect(target.target(for: "begin") == 0x103)
        let pending = idle.extend()
        let oldGesture = idle.gestureGeneration

        #expect(idle.selectScreen(2) == true)
        #expect(!idle.isCurrentGesture(oldGesture))
        #expect(idle.expire(pending) == false)
        #expect(target.target(for: "end") == 0x103)
        target.setScreen(2, universalHID: true)

        let next = idle.extend()
        #expect(!idle.isCurrentGesture(oldGesture))
        #expect(target.target(for: "begin") == 0x102)
        #expect(idle.expire(pending) == false)
        #expect(idle.isActive)
        #expect(idle.expire(next) == true)
        #expect(target.target(for: "end") == 0x102)
    }

    @Test("refreshing the same panel preserves wheel movement and its idle deadline")
    func samePanelPreservesWheel() {
        var idle = ScrollGestureIdle()
        #expect(idle.selectScreen(3) == false)
        let pending = idle.extend()
        let gesture = idle.gestureGeneration

        #expect(idle.selectScreen(3) == false)
        #expect(idle.isCurrentGesture(gesture))
        #expect(idle.expire(pending) == true)
    }

    @Test("losing the selected panel cancels wheel movement until a new wheel starts")
    func unknownPanelInterruptsWheel() {
        var idle = ScrollGestureIdle()
        #expect(idle.selectScreen(3) == false)
        let pending = idle.extend()
        let gesture = idle.gestureGeneration

        #expect(idle.selectScreen(nil) == true)
        #expect(!idle.isCurrentGesture(gesture))
        #expect(idle.expire(pending) == false)
        #expect(idle.selectScreen(2) == false)
        #expect(!idle.isActive)
    }

    @Test("screen selection leaves a held manual touch pinned until its own lift")
    func panelChangePreservesManualTouch() {
        var idle = ScrollGestureIdle()
        var target = HIDTargetPolicy()
        #expect(idle.selectScreen(3) == false)
        target.setScreen(3, universalHID: true)
        #expect(target.target(for: "begin") == 0x103)

        #expect(idle.selectScreen(2) == false)
        target.setScreen(2, universalHID: true)
        #expect(target.target(for: "move") == 0x103)
        #expect(target.target(for: "end") == 0x103)
        #expect(target.target(for: "begin") == 0x102)
    }

    @Test("wheel activity keeps one movement task valid while extending idle")
    func movementSurvivesActivity() {
        var idle = ScrollGestureIdle()
        let first = idle.extend()
        let gesture = idle.gestureGeneration
        let latest = idle.extend()
        #expect(idle.isCurrentGesture(gesture))
        #expect(idle.expire(first) == false)
        #expect(idle.isCurrentGesture(gesture))
        #expect(idle.expire(latest) == true)
        #expect(!idle.isCurrentGesture(gesture))
    }

    @Test("interruption rejects a queued movement task even after another drag starts")
    func rejectsInterruptedMovement() {
        var idle = ScrollGestureIdle()
        _ = idle.extend()
        let oldGesture = idle.gestureGeneration
        #expect(idle.interrupt() == true)
        #expect(!idle.isCurrentGesture(oldGesture))
        _ = idle.extend()
        #expect(!idle.isCurrentGesture(oldGesture))
        #expect(idle.isCurrentGesture(idle.gestureGeneration))
    }

    @Test("wheel activity extends one drag beyond an earlier idle deadline")
    func extendsDrag() {
        var idle = ScrollGestureIdle()
        let first = idle.extend()
        let second = idle.extend()

        #expect(idle.expire(first) == false)
        #expect(idle.isActive)
        #expect(idle.expire(second) == true)
        #expect(!idle.isActive)
        #expect(idle.expire(second) == false)
    }

    @Test("a queued idle callback cannot lift a direct gesture after interruption")
    func interruptedByDirectGesture() {
        var idle = ScrollGestureIdle()
        let pending = idle.extend()

        #expect(idle.interrupt() == true)
        #expect(idle.expire(pending) == false)
        #expect(idle.interrupt() == false)
    }

    @Test("an interrupted timer cannot end a later wheel drag")
    func interruptedBeforeNextDrag() {
        var idle = ScrollGestureIdle()
        let old = idle.extend()
        #expect(idle.interrupt() == true)
        let current = idle.extend()

        #expect(idle.expire(old) == false)
        #expect(idle.isActive)
        #expect(idle.expire(current) == true)
    }

    @Test("interrupting a wheel releases its pinned panel before a new touch begins")
    func interruptionKeepsPanelOwnership() {
        var idle = ScrollGestureIdle()
        var target = HIDTargetPolicy()
        target.setScreen(3, universalHID: true)
        #expect(target.target(for: "begin") == 0x103)
        let pending = idle.extend()
        target.setScreen(2, universalHID: true)

        #expect(idle.interrupt() == true)
        #expect(target.target(for: "end") == 0x103)
        #expect(target.target(for: "begin") == 0x102)
        #expect(idle.expire(pending) == false)
        #expect(target.target(for: "move") == 0x102)
    }
}
