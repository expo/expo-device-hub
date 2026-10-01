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
