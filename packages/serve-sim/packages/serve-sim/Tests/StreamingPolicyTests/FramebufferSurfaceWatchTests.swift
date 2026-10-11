import Testing

@testable import StreamingPolicy

@Suite("FramebufferSurfaceWatch")
struct FramebufferSurfaceWatchTests {
    private static let second: UInt64 = 1_000_000_000
    private static let tick: UInt64 = 16_666_667

    private func ms(_ value: UInt64) -> UInt64 { value * 1_000_000 }

    @Test("re-wires once a second before the first frame, without counting a loss")
    func beforeFirstFrame() {
        var watch = FramebufferSurfaceWatch(startNanoseconds: 0)
        #expect(watch.tick(atNanoseconds: ms(500), capturedAnyFrame: false) == .none)
        #expect(watch.tick(atNanoseconds: ms(1_000), capturedAnyFrame: false) == .rewire(lossStarted: false))
        #expect(watch.tick(atNanoseconds: ms(1_500), capturedAnyFrame: false) == .none)
        #expect(watch.tick(atNanoseconds: ms(2_000), capturedAnyFrame: false) == .rewire(lossStarted: false))
        #expect(watch.losses == 0)
        #expect(watch.rewires == 2)
    }

    @Test("never re-wires while each pick finds a surface, even on a static screen")
    func steadySurface() {
        var watch = FramebufferSurfaceWatch(startNanoseconds: 0)
        var now: UInt64 = 0
        for _ in 0..<600 {
            now += Self.tick
            #expect(watch.surfaceFound(atNanoseconds: now) == nil)
            #expect(watch.tick(atNanoseconds: now, capturedAnyFrame: true) == .none)
        }
        #expect(watch.rewires == 0)
        #expect(watch.lostNanoseconds(atNanoseconds: now) == 0)
    }

    @Test("a surface lost after the first frame re-wires each second and starts one loss")
    func lossAfterFirstFrame() {
        var watch = FramebufferSurfaceWatch(startNanoseconds: 0)
        _ = watch.surfaceFound(atNanoseconds: ms(10_000))
        #expect(watch.tick(atNanoseconds: ms(10_900), capturedAnyFrame: true) == .none)
        #expect(watch.tick(atNanoseconds: ms(11_000), capturedAnyFrame: true) == .rewire(lossStarted: true))
        #expect(watch.tick(atNanoseconds: ms(11_500), capturedAnyFrame: true) == .none)
        #expect(watch.tick(atNanoseconds: ms(12_000), capturedAnyFrame: true) == .rewire(lossStarted: false))
        #expect(watch.losses == 1)
        #expect(watch.lostNanoseconds(atNanoseconds: ms(12_000)) == ms(2_000))
    }

    @Test("counts the loss but does not re-wire while the device is not booted, and reads its state once per interval")
    func deviceNotBooted() {
        var watch = FramebufferSurfaceWatch(startNanoseconds: 0)
        _ = watch.surfaceFound(atNanoseconds: ms(10_000))
        var stateReads = 0
        func shutDown() -> Bool {
            stateReads += 1
            return false
        }
        var now = ms(10_000)
        while now < ms(15_000) {
            now += Self.tick
            #expect(watch.tick(atNanoseconds: now, capturedAnyFrame: true, deviceBooted: shutDown()) == .none)
        }
        #expect(watch.rewires == 0)
        #expect(watch.losses == 1)
        #expect(watch.lostNanoseconds(atNanoseconds: now) == now - ms(10_000))
        #expect(stateReads == 5)
    }

    @Test("the first re-wire after the device boots reports the loss, which covers the time it was off")
    func deviceBootsAgain() {
        var watch = FramebufferSurfaceWatch(startNanoseconds: 0)
        _ = watch.surfaceFound(atNanoseconds: ms(10_000))
        #expect(watch.tick(atNanoseconds: ms(11_000), capturedAnyFrame: true, deviceBooted: false) == .none)
        #expect(watch.tick(atNanoseconds: ms(60_000), capturedAnyFrame: true, deviceBooted: false) == .none)
        #expect(watch.tick(atNanoseconds: ms(61_000), capturedAnyFrame: true, deviceBooted: true) == .rewire(lossStarted: true))
        #expect(watch.tick(atNanoseconds: ms(62_000), capturedAnyFrame: true, deviceBooted: true) == .rewire(lossStarted: false))
        #expect(watch.rewires == 2)
        #expect(watch.losses == 1)
        #expect(watch.currentLossNanoseconds(atNanoseconds: ms(62_000)) == ms(52_000))
    }

    @Test("a device that boots between two checks re-wires at the next check, not sooner")
    func deviceBootsBetweenChecks() {
        var watch = FramebufferSurfaceWatch(startNanoseconds: 0)
        _ = watch.surfaceFound(atNanoseconds: ms(10_000))
        #expect(watch.tick(atNanoseconds: ms(11_000), capturedAnyFrame: true, deviceBooted: false) == .none)
        #expect(watch.tick(atNanoseconds: ms(11_100), capturedAnyFrame: true, deviceBooted: true) == .none)
        #expect(watch.tick(atNanoseconds: ms(11_900), capturedAnyFrame: true, deviceBooted: true) == .none)
        #expect(watch.tick(atNanoseconds: ms(12_000), capturedAnyFrame: true, deviceBooted: true) == .rewire(lossStarted: true))
    }

    @Test("a surface that returns while the device was never re-wired still ends a counted loss")
    func surfaceReturnsWithoutRewire() {
        var watch = FramebufferSurfaceWatch(startNanoseconds: 0)
        _ = watch.surfaceFound(atNanoseconds: ms(10_000))
        #expect(watch.tick(atNanoseconds: ms(11_000), capturedAnyFrame: true, deviceBooted: false) == .none)
        #expect(watch.surfaceFound(atNanoseconds: ms(14_000)) == ms(4_000))
        #expect(watch.losses == 1)
        #expect(watch.rewires == 0)
        #expect(watch.lostNanoseconds(atNanoseconds: ms(20_000)) == ms(4_000))
        #expect(watch.tick(atNanoseconds: ms(21_000), capturedAnyFrame: true, deviceBooted: true) == .rewire(lossStarted: true))
        #expect(watch.losses == 2)
    }

    @Test("before the first frame, a device that is not booted is not re-wired and counts no loss")
    func deviceNotBootedBeforeFirstFrame() {
        var watch = FramebufferSurfaceWatch(startNanoseconds: 0)
        #expect(watch.tick(atNanoseconds: ms(1_000), capturedAnyFrame: false, deviceBooted: false) == .none)
        #expect(watch.tick(atNanoseconds: ms(2_000), capturedAnyFrame: false, deviceBooted: true) == .rewire(lossStarted: false))
        #expect(watch.losses == 0)
        #expect(watch.rewires == 1)
    }

    @Test("the next surface ends the loss and reports how long it lasted")
    func lossEnds() {
        var watch = FramebufferSurfaceWatch(startNanoseconds: 0)
        _ = watch.surfaceFound(atNanoseconds: ms(10_000))
        _ = watch.tick(atNanoseconds: ms(11_000), capturedAnyFrame: true)
        #expect(watch.surfaceFound(atNanoseconds: ms(14_500)) == ms(4_500))
        #expect(watch.currentLossNanoseconds(atNanoseconds: ms(14_500)) == 0)
        #expect(watch.surfaceFound(atNanoseconds: ms(14_517)) == nil)
        #expect(watch.tick(atNanoseconds: ms(15_000), capturedAnyFrame: true) == .none)
        #expect(watch.lostNanoseconds(atNanoseconds: ms(20_000)) == ms(4_500))
    }

    @Test("a second loss counts again and adds to the lost time")
    func secondLoss() {
        var watch = FramebufferSurfaceWatch(startNanoseconds: 0)
        _ = watch.surfaceFound(atNanoseconds: ms(1_000))
        _ = watch.tick(atNanoseconds: ms(2_000), capturedAnyFrame: true)
        _ = watch.surfaceFound(atNanoseconds: ms(3_000))
        #expect(watch.tick(atNanoseconds: ms(4_000), capturedAnyFrame: true) == .rewire(lossStarted: true))
        #expect(watch.losses == 2)
        #expect(watch.currentLossNanoseconds(atNanoseconds: ms(5_000)) == ms(2_000))
        #expect(watch.lostNanoseconds(atNanoseconds: ms(5_000)) == ms(2_000) + ms(2_000))
    }
}
